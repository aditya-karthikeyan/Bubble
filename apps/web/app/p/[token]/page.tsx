import { LiveFeed } from './live-feed';

export default async function PlanPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return (
    <main style={{ padding: 16, maxWidth: 560, margin: '0 auto' }}>
      <h1 style={{ fontSize: 22 }}>Live plan</h1>
      <LiveFeed token={token} />
    </main>
  );
}
