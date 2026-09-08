import { createRequire } from 'module';

const _require = createRequire(import.meta.url);
type RobotsInstance = { isAllowed(url: string, ua?: string): boolean | undefined };
const robotsParser = _require('robots-parser') as (url: string, text: string) => RobotsInstance;

const USER_AGENT = 'CLONYFY/0.1';

export async function checkRobots(targetUrl: string): Promise<{ allowed: boolean; reason: string }> {
  const u = new URL(targetUrl);
  const robotsUrl = `${u.protocol}//${u.host}/robots.txt`;

  try {
    const res = await fetch(robotsUrl, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      // No robots.txt or unreachable — assume allowed
      return { allowed: true, reason: 'no robots.txt found' };
    }
    const text = await res.text();
    const robots = robotsParser(robotsUrl, text);
    const allowed = robots.isAllowed(targetUrl, USER_AGENT) ?? true;
    return {
      allowed,
      reason: allowed ? 'robots.txt allows access' : `robots.txt disallows ${targetUrl} for ${USER_AGENT}`,
    };
  } catch {
    return { allowed: true, reason: 'robots.txt unreachable, proceeding' };
  }
}
