/**
 * The four plan steps the live window's address bar walks through, and what each step's page
 * says when you click back to it. Only page-visible facts: who is in, which places, what the
 * helpers did, the booking. Never anyone's constraints.
 */
import type { DoerKind } from '@bubbleworks/shared';
import { DOER_KINDS, type Phase, type ViewModel } from './view-model';

export const STEPS: { long: string; short: string; phases: Phase[] }[] = [
  { long: 'Gather', short: 'Gather', phases: ['gathering'] },
  { long: 'Find a place', short: 'Find', phases: ['candidates', 'convergence', 'deadlock'] },
  { long: 'Make it happen', short: 'Book', phases: ['locked'] },
  { long: 'See you there', short: 'Done', phases: ['summary', 'complete'] },
];

/** The step a phase belongs to. A plan that closed without a booking ended while finding. */
export function stepOf(phase: Phase): number {
  const i = STEPS.findIndex((s) => s.phases.includes(phase));
  return i === -1 ? 1 : i;
}

const DOER_NAME: Record<DoerKind, string> = {
  caller: 'Caller',
  inviter: 'Inviter',
  splitter: 'Splitter',
  watcher: 'Watcher',
};

/** "Ava", "Ava and Ben", "Ava, Ben and Chloe". */
export function joinNames(names: string[]): string {
  return names.length <= 1
    ? (names[0] ?? '')
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

const time = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

export function stepSummary(step: number, vm: ViewModel): { title: string; lines: string[] } {
  if (step === 0) {
    const inn = vm.bubbles.filter((b) => b.present).map((b) => b.displayName);
    const out = vm.bubbles.filter((b) => !b.present).map((b) => b.displayName);
    return {
      title: 'Who’s in',
      lines: [
        inn.length ? `${joinNames(inn)} ${inn.length === 1 ? 'is' : 'are'} in.` : 'Nobody yet.',
        ...(out.length ? [`${joinNames(out)} dropped out.`] : []),
        'Each bubble speaks for its person, privately.',
      ],
    };
  }
  if (step === 1) {
    const out = vm.venues.filter((v) => v.eliminated).map((v) => v.name);
    const leader = vm.venues.find((v) => v.venueId === vm.leaderVenueId)?.name;
    const n = vm.venues.length;
    return {
      title: 'Finding a place',
      lines: [
        `${n} ${n === 1 ? 'place' : 'places'} in the running.`,
        ...(out.length ? [`Ruled out: ${joinNames(out)}.`] : []),
        vm.locked
          ? `Agreed on ${vm.locked.venue.name}${vm.locked.backup ? `, backup ${vm.locked.backup.name}` : ''}.`
          : leader
            ? `Leading: ${leader}.`
            : 'No favourite yet.',
      ],
    };
  }
  if (step === 2) {
    const lines = DOER_KINDS.flatMap((k) => {
      const d = vm.doers[k];
      return d ? [`${DOER_NAME[k]}: ${d.detail ?? d.state.replace('_', ' ')}`] : [];
    });
    return {
      title: 'Making it happen',
      lines: lines.length ? lines : ['The helpers start once the crew agrees.'],
    };
  }
  return {
    title: 'See you there',
    lines: vm.booking
      ? [
          `${vm.booking.venue.name} at ${time(vm.booking.startAt)}, table for ${vm.booking.partySize} under ${vm.booking.reservationName}.`,
        ]
      : ['Not booked yet.'],
  };
}
