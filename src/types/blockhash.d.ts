declare module 'blockhash' {
  export interface ImageData {
    data: Uint8ClampedArray | Buffer;
    width: number;
    height: number;
  }

  /**
   * Calculate a perceptual hash of an image.
   * @param data The image data.
   * @param bits The number of bits for the hash (e.g., 8 for 8x8).
   * @param method The hashing method (e.g., 1 for bmvbhash_even).
   */
  export function blockhashData(data: ImageData, bits: number, method: number): string;

  /**
   * Calculate the Hamming distance between two hex hashes.
   */
  export function hammingDistance(h1: string, h2: string): number;
}
