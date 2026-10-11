import type { Metadata } from 'next';
import { LivePlan } from '../../../src/live/live-plan';

export const metadata: Metadata = {
  title: 'Live plan · Bubbleworks',
  description: 'Watch the bubbles plan dinner, live.',
};

export default async function PlanPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ replay?: string }>;
}) {
  const { token } = await params;
  const { replay } = await searchParams;
  return <LivePlan token={token} replay={replay ?? null} />;
}
