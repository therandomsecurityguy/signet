declare module 'rdf-canonize' {
  export function canonize(
    input: string,
    options: {
      algorithm: string;
      inputFormat?: string;
      format?: string;
    },
  ): Promise<string>;
}
