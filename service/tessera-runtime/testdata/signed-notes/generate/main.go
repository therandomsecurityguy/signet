// Command generate produces the signed-note compatibility fixture with the
// REAL transparency-dev note library (golang.org/x/mod/sumdb/note), which is
// already a dependency of this module. The fixture is committed so both the Go
// test (note_fixture_test.go) and the registry's TypeScript tests verify the
// same bytes — one oracle, two implementations.
//
// Reproduce with:
//
//	cd service/tessera-runtime/testdata/signed-notes/generate
//	go run . > ../spec-note-v1.json
//
// Deterministic by construction: the Ed25519 key is derived from a fixed seed
// (sha256 of a constant), the tree root is sha256 of a constant, and Ed25519
// signatures are deterministic — the output is byte-stable.
package main

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"os"

	"golang.org/x/mod/sumdb/note"
)

const (
	fixtureName = "signet-fixture-log"
	treeSize    = 3
)

func keyHash(name string, key []byte) uint32 {
	h := sha256.New()
	h.Write([]byte(name))
	h.Write([]byte("\n"))
	h.Write(key)
	return binary.BigEndian.Uint32(h.Sum(nil))
}

func main() {
	seed := sha256.Sum256([]byte("signet-signed-note-fixture-key"))
	key := ed25519.NewKeyFromSeed(seed[:])

	privkey := append([]byte{1}, seed[:]...)
	pubkey := append([]byte{1}, key.Public().(ed25519.PublicKey)...)
	hash := keyHash(fixtureName, pubkey)

	skey := fmt.Sprintf("PRIVATE+KEY+%s+%08x+%s", fixtureName, hash, base64.StdEncoding.EncodeToString(privkey))
	vkey := fmt.Sprintf("%s+%08x+%s", fixtureName, hash, base64.StdEncoding.EncodeToString(pubkey))

	signer, err := note.NewSigner(skey)
	if err != nil {
		panic(err)
	}
	verifier, err := note.NewVerifier(vkey)
	if err != nil {
		panic(err)
	}

	root := sha256.Sum256([]byte("signet-fixture-root"))
	body := fmt.Sprintf("%s\n%d\n%s\n", fixtureName, treeSize, base64.StdEncoding.EncodeToString(root[:]))
	signed, err := note.Sign(&note.Note{Text: body}, signer)
	if err != nil {
		panic(err)
	}
	opened, err := note.Open(signed, note.VerifierList(verifier))
	if err != nil || opened.Text != body {
		panic(fmt.Sprintf("self-check failed: %v", err))
	}

	fixture := map[string]any{
		"name":                fixtureName,
		"tree_size":           treeSize,
		"root_hash_hex":       fmt.Sprintf("%x", root[:]),
		"seed_hex":            fmt.Sprintf("%x", seed[:]),
		"key_hash_hex":        fmt.Sprintf("%08x", hash),
		"private_key":         skey,
		"verifier_key":        vkey,
		"note_body":           body,
		"signed_note":         string(signed),
		"opened_text_matches": true,
	}
	out, err := json.MarshalIndent(fixture, "", "  ")
	if err != nil {
		panic(err)
	}
	if _, err := os.Stdout.Write(append(out, '\n')); err != nil {
		panic(err)
	}
}
