// Best-effort SSRF guard for outbound fetches of user/article-controlled URLs.
// Workers cannot resolve DNS, so this hardens hostname literals only: it forces
// canonical IPv4 form (pure-decimal / octal / hex / mixed-radix spellings are all
// treated private), blocks private/special ranges and local IPv6, and fails closed
// on unparseable input.
// Known limits (accepted): DNS rebinding and attacker-owned DNS pointing at
// internal IPs cannot be detected without a resolver; callers use short timeouts.
export function isPrivateHostname(hostname) {
	const host = String(hostname || '')
		.trim()
		.toLowerCase()
		.replace(/^\[|\]$/g, '');
	if (!host) return true;
	if (host === 'localhost' || host.endsWith('.localhost')) return true;
	if (host.endsWith('.local') || host.endsWith('.internal')) return true;

	if (host.includes(':')) {
		return isPrivateIpv6(host);
	}

	// Dotted forms (decimal, octal, hex, mixed): only canonical dotted-quad decimal
	// with a public range is safe, everything else fails closed.
	if (host.includes('.')) {
		const octetLike = /^(0x[0-9a-f]+|0[0-7]*|\d+)$/i;
		if (host.split('.').every((part) => octetLike.test(part))) {
			return isPrivateIpv4Like(host);
		}
		return false; // regular public domain name
	}

	// Non-dotted IPv4 spellings: pure decimal 2130706433, hex 0x7f000001, octal 0177.
	if (/^\d+$/.test(host) || /^0x[0-9a-f]+$/.test(host) || /^0[0-7]+$/.test(host)) {
		return true;
	}

	return false; // regular public domain name
}

function isPrivateIpv4Like(host) {
	const parts = host.split('.');
	// Non-canonical quad (wrong length) or legacy encodings (leading zeros / hex)
	// cannot be interpreted reliably => treat private (fail closed).
	if (parts.length !== 4) return true;
	const canonical = parts.every((p) => /^\d+$/.test(p) && (p.length === 1 || p[0] !== '0'));
	if (!canonical) return true;
	const nums = parts.map(Number);
	if (nums.some((n) => n > 255)) return true; // not a real dotted-quad => fail closed
	const [a, b] = nums;
	if (a === 0 || a === 10 || a === 127) return true; // this-network, private, loopback
	if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
	if (a === 169 && b === 254) return true; // link-local
	if (a === 172 && b >= 16 && b <= 31) return true; // private
	if (a === 192 && (b === 0 || b === 168)) return true; // test-nets, private
	if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
	if (a >= 224) return true; // multicast / reserved / broadcast
	return false;
}

function isPrivateIpv6(host) {
	if (host === '::1' || host === '::' || host === '0:0:0:0:0:0:0:1') return true;

	// IPv4-mapped / -compatible with a dotted tail: ::ffff:127.0.0.1
	const mappedMatch = host.match(/(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/);
	if (mappedMatch) {
		return isPrivateIpv4Like(mappedMatch[1]);
	}
	if (/(^|:)(?:ffff|0000)(?::|$)/i.test(host)) {
		// embedded-IPv4 hex forms / v4-compatible ::aabbccdd cannot be canonicalized
		// reliably => fail closed (private)
		return true;
	}

	const first = host[0];
	if (first === 'f' || first === 'e') {
		// fc00::/7 unique-local (fc/fd), fe80::/10 link-local (fe8-feb)
		if (/^f[cd]/.test(host)) return true;
		if (/^fe[89ab]/.test(host)) return true;
	}
	return false;
}

export function isSsrfSafeUrl(rawUrl) {
	try {
		const url = new URL(String(rawUrl));
		if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
		return !isPrivateHostname(url.hostname);
	} catch {
		return false;
	}
}
