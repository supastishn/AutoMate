declare module '@heyputer/puter.js' {
  interface PuterAI {
    chat(prompt: string, options?: { model?: string; stream?: boolean }): Promise<any>;
    txt2img(prompt: string, options?: { model?: string; quality?: string }): Promise<{ src?: string }>;
  }

  interface Puter {
    ai: PuterAI;
    setAuthToken(token: string): void;
  }

  const puter: Puter;
  export default puter;
}

declare module '@heyputer/puter.js/src/init.cjs' {
  const init: () => void;
  export default init;
}
