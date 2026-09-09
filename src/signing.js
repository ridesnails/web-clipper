// HMAC-signed URL params for the two pre-auth GET endpoints (/html-view, /image-proxy).
// These endpoints cannot use the Authorization header (browser <img>/<iframe> requests),
// so the worker mints signed URLs (sig = HMAC-SHA256(paramValue, key)) when it renders
// notes, and verification happens before any fetch.
// Key material: SIGNING_SECRET if configured, else API_KEY. Neither present => fail-closed.
const encoder = new TextEncoder();

function getSigningKeyMaterial(env) {
	const secret = env?.SIGNING_SECRET || env?.API_KEY;
	if (!secret) {
		throw new Error('No signing secret configured (set SIGNING_SECRET or API_KEY)');
	}
	return encoder.encode(secret);
}

function toHex(buffer) {
	return Array.from(new Uint8Array(buffer))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}

export async function signParam(value, env) {
	const key = await crypto.subtle.importKey('raw', getSigningKeyMaterial(env), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
	const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(String(value)));
	return toHex(mac);
}

export async function verifyParam(value, sig, env) {
	if (!sig || typeof sig !== 'string') return false;
	let expected;
	try {
		expected = await signParam(value, env);
	} catch {
		return false; // no secret configured => fail-closed
	}
	return timingSafeEqualStrings(sig, expected);
}

export function timingSafeEqualStrings(a, b) {
	const ba = encoder.encode(String(a));
	const bb = encoder.encode(String(b));
	if (ba.length !== bb.length) return false;
	let diff = 0;
	for (let i = 0; i < ba.length; i++) {
		diff |= ba[i] ^ bb[i];
	}
	return diff === 0;
}
