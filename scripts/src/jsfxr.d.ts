/** Minimal typings for jsfxr 1.4.1 (ships no types). Only what audio.ts uses. */
declare module 'jsfxr' {
  export interface SfxrParams {
    fromJSON(struct: Record<string, number>): SfxrParams;
    [key: string]: unknown;
  }
  export interface SfxrSound {
    dataURI: string;
    clipping: number;
  }
  const jsfxr: {
    Params: new () => SfxrParams;
    SoundEffect: new (params: SfxrParams | string) => { generate(): SfxrSound };
  };
  export default jsfxr;
}
