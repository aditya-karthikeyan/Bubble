import { LiveFeed } from './live-feed';

export default async function PlanPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return (
    <main className="sky">
      <div className="wrap">
        <h1 style={{ fontSize: 22 }}>Live plan</h1>
        <LiveFeed token={token} />
      </div>
    </main>
  );
}
