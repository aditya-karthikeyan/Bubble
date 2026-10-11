import type { Metadata } from 'next';
import { SignupForm } from '../../signup-form';
import { SERVER_URL } from '../../site';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Join a crew · Bubbleworks',
  description: 'Get your bubble and land in your friends’ crew.',
};

async function crewName(code: string): Promise<string | null> {
  try {
    const res = await fetch(`${SERVER_URL}/api/crews/${encodeURIComponent(code)}`, {
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { ok: boolean; name?: string };
    return body.ok && body.name ? body.name : null;
  } catch {
    return null;
  }
}

export default async function JoinPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const name = await crewName(code);
  return (
    <main className="sky">
      <div className="wrap">
        <header className="hero">
          <div className="orb" aria-hidden />
          <h1>{name ? `Join ${name}` : 'Join a crew'}</h1>
          <p className="lede">
            {name
              ? `Get your bubble and you're in ${name}. Already have one? Your number is enough. Then anyone in the crew can text "dinner tonight?" and the bubbles plan it.`
              : "That link doesn't match a crew anymore. Ask whoever made it for a fresh one, or get your own bubble below."}
          </p>
        </header>
        <SignupForm {...(name ? { crewCode: code, crewName: name } : {})} />
      </div>
    </main>
  );
}
