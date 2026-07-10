const COMPANY_SUFFIXES = [
    'lda', 'sa', 'srl', 'sas', 'sarl', 'gmbh', 'ltd', 'llc', 'inc', 'corp',
    'co', 'pty', 'bv', 'ag', 'sl', 'slu', 'unipessoal', 'limitada',
    'sociedade', 'eirl', 'sgps', 'nv'
];

const RESERVED_USERNAMES = [
    'admin', 'fixtract', 'fixera', 'support', 'help', 'staff', 'system',
    'moderator', 'null', 'undefined', 'api', 'www', 'mail',
    'contact', 'info', 'billing', 'security', 'root'
];

const ACCENT_MAP: Record<string, string> = {
    'à': 'a', 'á': 'a', 'â': 'a', 'ã': 'a', 'ä': 'a', 'å': 'a',
    'æ': 'ae', 'ç': 'c', 'è': 'e', 'é': 'e', 'ê': 'e', 'ë': 'e',
    'ì': 'i', 'í': 'i', 'î': 'i', 'ï': 'i', 'ð': 'd', 'ñ': 'n',
    'ò': 'o', 'ó': 'o', 'ô': 'o', 'õ': 'o', 'ö': 'o', 'ø': 'o',
    'ù': 'u', 'ú': 'u', 'û': 'u', 'ü': 'u', 'ý': 'y', 'ÿ': 'y',
    'þ': 'th', 'ß': 'ss',
    'ą': 'a', 'ć': 'c', 'ę': 'e', 'ł': 'l', 'ń': 'n', 'ś': 's',
    'ź': 'z', 'ż': 'z', 'č': 'c', 'ď': 'd', 'ě': 'e', 'ň': 'n',
    'ř': 'r', 'š': 's', 'ť': 't', 'ů': 'u', 'ž': 'z',
    'ő': 'o', 'ű': 'u', 'ă': 'a', 'ș': 's', 'ț': 't'
};

export function normalizeToSlug(text: string): string {
    let result = text.toLowerCase();
    result = result.replace(/[àáâãäåæçèéêëìíîïðñòóôõöøùúûüýÿþßąćęłńśźżčďěňřšťůžőűășț]/g,
        (char) => ACCENT_MAP[char] || char
    );
    result = result.replace(/[^a-z0-9]+/g, '-');
    result = result.replace(/-{2,}/g, '-');
    result = result.replace(/^-|-$/g, '');
    return result;
}

export function stripCompanySuffix(name: string): string {
    let result = name.trim();
    for (const suffix of COMPANY_SUFFIXES) {
        const regex = new RegExp(`[\\s,]+${suffix}[\\s.,]*$`, 'gi');
        const stripped = result.replace(regex, '');
        if (stripped !== result) {
            result = stripped.trim();
            break;
        }
    }
    return result.trim();
}

export function generateUsername(companyName: string, city?: string): string {
    const stripped = stripCompanySuffix(companyName);
    const slug = normalizeToSlug(stripped);
    if (!slug) return '';

    const words = slug.split('-').filter(Boolean);
    const citySlug = city ? normalizeToSlug(city) : '';

    let candidates: string[] = [];

    if (words.length <= 2) {
        if (citySlug) candidates.push(`${words.join('-')}-${citySlug}`);
        candidates.push(words.join('-'));
    } else {
        const initials = words.map(w => w[0]).join('');
        if (citySlug) candidates.push(`${initials}-${citySlug}`);
        candidates.push(`${initials}-${words[0]}`);
        if (citySlug) candidates.push(`${words[0]}-${citySlug}`);
        candidates.push(words[0]);
    }

    for (const candidate of candidates) {
        const truncated = truncateUsername(candidate);
        if (truncated.length >= 3 && truncated.length <= 30) return truncated;
    }

    const fallback = slug.slice(0, 27);
    const truncated = truncateUsername(fallback);
    return truncated.length >= 3 ? truncated : '';
}

function truncateUsername(username: string): string {
    if (username.length <= 30) return username;
    const cut = username.slice(0, 30);
    const lastHyphen = cut.lastIndexOf('-');
    if (lastHyphen > 2) return cut.slice(0, lastHyphen);
    return cut.replace(/-$/, '');
}

export function generateUsernameSuggestions(companyName: string, city?: string): string[] {
    const stripped = stripCompanySuffix(companyName);
    const slug = normalizeToSlug(stripped);
    if (!slug) return [];

    const words = slug.split('-').filter(Boolean);
    const citySlug = city ? normalizeToSlug(city) : '';
    const suggestions: string[] = [];

    if (citySlug) {
        suggestions.push(truncateUsername(`${words.join('-')}-${citySlug}`));
    }
    if (words.length > 1 && citySlug) {
        suggestions.push(truncateUsername(`${words[0]}-${citySlug}`));
    }
    if (words.length > 1) {
        const initials = words.map(w => w[0]).join('');
        if (citySlug) suggestions.push(truncateUsername(`${initials}-${citySlug}`));
    }

    const suffix = Math.floor(Math.random() * 900 + 100);
    suggestions.push(truncateUsername(`${words[0]}-${suffix}`));

    return [...new Set(suggestions)].filter(
        s => s.length >= 3 && s.length <= 30 && /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/.test(s)
    );
}

function levenshteinDistance(a: string, b: string): number {
    const m = a.length;
    const n = b.length;
    const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            dp[i][j] = a[i - 1] === b[j - 1]
                ? dp[i - 1][j - 1]
                : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
        }
    }
    return dp[m][n];
}

const GENERIC_COMPANY_TOKENS = new Set([
    'and', 'the', 'et', 'en', 'de', 'di', 'da', 'le', 'la', 'les', 'des', 'du',
    'services', 'service', 'group', 'groupe', 'company', 'co', 'solutions',
    'works', 'pro', 'pros', 'professional', 'professionals',
    'plumbing', 'electrical', 'electric', 'cleaning', 'repair', 'repairs',
    'construction', 'building', 'renovation', 'renovations', 'maintenance',
    'painting', 'carpentry', 'gardening', 'landscaping', 'hvac', 'heating',
    'cooling', 'roofing', 'flooring', 'tiling', 'installation', 'installations',
]);

function getDistinctiveCompanyTokens(companyName: string): string[] {
    const slug = normalizeToSlug(stripCompanySuffix(companyName));
    if (!slug) return [];
    return slug
        .split('-')
        .filter((w) => w.length >= 3 && !GENERIC_COMPANY_TOKENS.has(w));
}

export function isTooSimilarToCompanyName(username: string, companyName: string): boolean {
    const sluggedCompany = normalizeToSlug(stripCompanySuffix(companyName));
    const normalizedUsername = normalizeToSlug(username);
    if (!sluggedCompany || !normalizedUsername) return false;

    if (normalizedUsername === sluggedCompany) return true;
    if (sluggedCompany.length >= 3 && normalizedUsername.includes(sluggedCompany)) return true;
    if (levenshteinDistance(normalizedUsername, sluggedCompany) < 3) return true;

    const usernameTokens = new Set(normalizedUsername.split('-').filter(Boolean));
    for (const token of getDistinctiveCompanyTokens(companyName)) {
        if (usernameTokens.has(token)) return true;
        if (token.length >= 5 && normalizedUsername.includes(token)) return true;
    }
    return false;
}

export function isValidUsernameFormat(username: string): { valid: boolean; reason?: string } {
    if (!username) return { valid: false, reason: 'Username is required' };
    if (username.length < 3) return { valid: false, reason: 'Username must be at least 3 characters' };
    if (username.length > 30) return { valid: false, reason: 'Username cannot exceed 30 characters' };
    if (!/^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/.test(username)) {
        return { valid: false, reason: 'Username can only contain lowercase letters, numbers, and hyphens. Must start and end with a letter or number.' };
    }
    if (username.includes('--')) return { valid: false, reason: 'Username cannot contain consecutive hyphens' };
    if (RESERVED_USERNAMES.includes(username)) return { valid: false, reason: 'This username is reserved' };
    return { valid: true };
}
