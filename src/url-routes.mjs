const CREDENTIAL_LOGIN_PATH = /\/(?:log[-_]?in|sign[-_]?in|auth)(?:\.(?:php|asp|aspx|html?))?(?:\/|$)/i;
const LOGIN_OR_SIGN_IN_PATH = /\/(?:log[-_]?in|sign[-_]?in)(?:\.(?:php|asp|aspx|html?))?(?:\/|$)/i;

function routeParts(value) {
  try {
    const url = new URL(String(value ?? ""));
    return [url.pathname, url.hash.startsWith("#/") ? url.hash.slice(1) : ""];
  } catch {
    return [];
  }
}

export function isCredentialLoginRoute(value) {
  return routeParts(value).some((part) => CREDENTIAL_LOGIN_PATH.test(part));
}

export function isLoginOrSignInRoute(value) {
  return routeParts(value).some((part) => LOGIN_OR_SIGN_IN_PATH.test(part));
}
