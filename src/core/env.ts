/** Environment probing that stays safe in Node (tests) as well as in the browser bundle. */

const env = (import.meta.env ?? {}) as { DEV?: boolean; PROD?: boolean; MODE?: string; BASE_URL?: string };

export const IS_DEV: boolean = env.DEV === true;
export const IS_PROD: boolean = env.PROD === true;
export const MODE: string = env.MODE ?? 'production';
export const APP_VERSION = '1.0.0';
