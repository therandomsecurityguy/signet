// Command generate produces the tlog-tiles compatibility fixture using the
// public transparency-dev/tessera layout + serialization packages:
// - github.com/transparency-dev/tessera/api/layout (paths, partial sizes)
// - github.com/transparency-dev/tessera/api      (HashTile/EntryBundle
//   serialization, verified in the Go test)
//
// Reproduce with:
//
//	cd service/tessera-runtime/testdata/tiles/generate
//	go run . > ../spec-tiles-v1.json
//
// Deterministic: payloads are indexed constants; RFC 6962 hashing is
// deterministic.
package main

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"os"

	"github.com/transparency-dev/tessera/api"
	"github.com/transparency-dev/tessera/api/layout"
)

const treeSize = 300

func payload(i int) []byte {
	return []byte(fmt.Sprintf("signet-tile-fixture-%d", i))
}

func leafHash(data []byte) []byte {
	h := sha256.New()
	h.Write([]byte{0x00})
	h.Write(data)
	return h.Sum(nil)
}

func nodeHash(left, right []byte) []byte {
	h := sha256.New()
	h.Write([]byte{0x01})
	h.Write(left)
	h.Write(right)
	return h.Sum(nil)
}

// subtreeRoot mirrors RFC 6962 split rules over a power-of-two aligned range.
func subtreeRoot(leafHashes [][]byte, start, end int) []byte {
	if end-start == 1 {
		return leafHashes[start]
	}
	k := 1
	for k < end-start {
		k <<= 1
	}
	k >>= 1
	return nodeHash(subtreeRoot(leafHashes, start, start+k), subtreeRoot(leafHashes, start+k, end))
}

func main() {
	leafHashes := make([][]byte, treeSize)
	payloads := make([]string, treeSize)
	for i := 0; i < treeSize; i++ {
		payloads[i] = string(payload(i))
		leafHashes[i] = leafHash([]byte(payloads[i]))
	}
	root := subtreeRoot(leafHashes, 0, treeSize)

	tiles := map[string]string{}
	addTile := func(level, index uint64) {
		partial := layout.PartialTileSize(level, index, treeSize)
		width := layout.TileWidth
		if partial > 0 {
			width = int(partial)
		}
		span := 1 << (level * layout.TileHeight)
		nodes := make([][]byte, 0, width)
		for offset := 0; offset < width; offset++ {
			start := int(index)*layout.TileWidth*span + offset*span
			nodes = append(nodes, subtreeRoot(leafHashes, start, start+span))
		}
		raw, err := (&api.HashTile{Nodes: nodes}).MarshalText()
		if err != nil {
			panic(err)
		}
		tiles[layout.TilePath(level, index, partial)] = base64.StdEncoding.EncodeToString(raw)
	}
	addTile(0, 0)
	addTile(0, 1)
	addTile(1, 0)

	entries := map[string]string{}
	addEntries := func(index uint64) {
		partial := layout.PartialTileSize(0, index, treeSize)
		width := layout.EntryBundleWidth
		if partial > 0 {
			width = int(partial)
		}
		var raw []byte
		for offset := 0; offset < width; offset++ {
			data := payload(int(index)*layout.EntryBundleWidth + offset)
			if len(data) > 0xffff {
				panic("payload too large for the uint16 length prefix")
			}
			var prefix [2]byte
			binary.BigEndian.PutUint16(prefix[:], uint16(len(data)))
			raw = append(raw, prefix[:]...)
			raw = append(raw, data...)
		}
		entries[layout.EntriesPath(index, partial)] = base64.StdEncoding.EncodeToString(raw)
	}
	addEntries(0)
	addEntries(1)

	leafHashesHex := make([]string, treeSize)
	for i, h := range leafHashes {
		leafHashesHex[i] = fmt.Sprintf("%x", h)
	}

	fixture := map[string]any{
		"tree_size":       treeSize,
		"root_hash_hex":   fmt.Sprintf("%x", root),
		"payloads":        payloads,
		"leaf_hashes_hex": leafHashesHex,
		"tiles":           tiles,
		"entries":         entries,
	}
	out, err := json.MarshalIndent(fixture, "", "  ")
	if err != nil {
		panic(err)
	}
	if _, err := os.Stdout.Write(append(out, '\n')); err != nil {
		panic(err)
	}
}
