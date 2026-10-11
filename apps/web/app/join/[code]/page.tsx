import type { Metadata } from 'next';
import { AeroWindow, Desktop, TaskButton, Taskbar } from '../../aero';
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
  const title = name ? `Join ${name}` : 'Join a crew';
  return (
    <main className="sky poster">
      <Desktop />
      <AeroWindow
        className="poster-window"
        title={title}
        labelledBy="join-heading"
        id="join"
        windowId="join"
        closeHref="/"
      >
        <div className="signup-inner">
          <div className="form-heading">
            <span className="form-orb" aria-hidden="true" />
            <h1 className="instruction" id="join-heading">
              {title}
            </h1>
            <p>
              {name
                ? `Get your bubble and you're in ${name}. Already have one? Your number is enough. Then anyone in the crew can text "dinner tonight?" and the bubbles plan it.`
                : "That link doesn't match a crew anymore. Ask whoever made it for a fresh one, or get your own bubble below."}
            </p>
          </div>
          <SignupForm {...(name ? { crewCode: code, crewName: name } : {})} />
        </div>
      </AeroWindow>
      <Taskbar>
        <TaskButton windowId="join" href="#join" className="active">
          <span className="tiny-orb" aria-hidden="true" />
          <span className="task-long">{title}</span>
          <span className="task-short">Join</span>
        </TaskButton>
      </Taskbar>
    </main>
  );
}
