/**
 * Where the panel lives on every address that shows it: a website's own domain (mybakery.com/assistant,
 * routed there by the server's proxy) and the panel's own address. Set in next.config.ts as the basePath;
 * links from next/link get it by themselves, plain fetches and form actions add it with `withBase`.
 */
export const BASE_PATH = '/assistant';

export const withBase = (path: string) => `${BASE_PATH}${path}`;
