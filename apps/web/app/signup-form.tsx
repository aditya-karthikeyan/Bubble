'use client';

import { useState, type FormEvent } from 'react';
import { ClientQr } from './client-qr';
import { prettyPhone, toE164 } from './phone';
import { SERVER_URL } from './site';

interface SignupResponse {
  ok: boolean;
  bubbleNumber?: string;
  smsLink?: string | null;
  crewName?: string | null;
  error?: string;
}

interface JoinResponse {
  ok: boolean;
  known?: boolean;
  crewName?: string;
  error?: string;
}

type State =
  | { kind: 'idle' }
  | { kind: 'sending' }
  | { kind: 'error'; message: string }
  | { kind: 'done'; bubbleNumber: string | null; smsLink: string | null; crewName: string | null }
  | { kind: 'joined'; crewName: string };

/**
 * The signup form. With a crew code (the join page) it also offers "Already have a bubble? Just
 * your number": a known phone goes straight into the crew, an unknown one comes back here to the
 * full form with the number filled in.
 */
export function SignupForm({ crewCode, crewName }: { crewCode?: string; crewName?: string } = {}) {
  const [state, setState] = useState<State>({ kind: 'idle' });
  const [quick, setQuick] = useState(false);
  const [phoneHint, setPhoneHint] = useState<string | null>(null);

  async function quickJoin(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!crewCode) return;
    const raw = String(new FormData(e.currentTarget).get('phone') ?? '');
    const phone = toE164(raw);
    if (!phone)
      return setState({
        kind: 'error',
        message: 'That phone number looks off. Try 10 digits, like 704 555 1234.',
      });
    setState({ kind: 'sending' });
    try {
      const res = await fetch(`${SERVER_URL}/api/crews/${encodeURIComponent(crewCode)}/join`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ phone }),
      });
      const body = (await res.json()) as JoinResponse;
      if (!res.ok || !body.ok) {
        return setState({ kind: 'error', message: 'That link or number did not work. Try again.' });
      }
      if (body.known) {
        return setState({ kind: 'joined', crewName: body.crewName ?? crewName ?? 'the crew' });
      }
      // New number: the full form, with the phone they typed already in it.
      setPhoneHint(raw);
      setQuick(false);
      setState({
        kind: 'error',
        message: "We don't have that number yet. Add your name and email to get your bubble.",
      });
    } catch {
      setState({
        kind: 'error',
        message: "Couldn't reach Bubbleworks. Check your connection and try again.",
      });
    }
  }

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const name = String(form.get('name') ?? '').trim();
    const email = String(form.get('email') ?? '').trim();
    const phone = toE164(String(form.get('phone') ?? ''));
    if (!name) return setState({ kind: 'error', message: 'Add your name.' });
    if (!phone)
      return setState({
        kind: 'error',
        message: 'That phone number looks off. Try 10 digits, like 704 555 1234.',
      });

    setState({ kind: 'sending' });
    try {
      const res = await fetch(`${SERVER_URL}/api/signup`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, email, phone, ...(crewCode ? { crewCode } : {}) }),
      });
      const body = (await res.json()) as SignupResponse;
      if (!res.ok || !body.ok) {
        return setState({ kind: 'error', message: 'Check your email and phone, then try again.' });
      }
      const number =
        body.bubbleNumber && body.bubbleNumber.startsWith('+') ? body.bubbleNumber : null;
      setState({
        kind: 'done',
        bubbleNumber: number,
        smsLink: body.smsLink ?? (number ? `sms:${number}` : null),
        crewName: body.crewName ?? crewName ?? null,
      });
    } catch {
      setState({
        kind: 'error',
        message: "Couldn't reach Bubbleworks. Check your connection and try again.",
      });
    }
  }

  if (state.kind === 'joined') {
    return (
      <div className="glass" aria-live="polite">
        <h2 style={{ margin: '0 0 4px', fontSize: 22 }}>You&apos;re in {state.crewName}</h2>
        <p className="lede">
          Your bubble is texting you now. Anyone in the crew can text it &ldquo;dinner
          tonight?&rdquo; to start a plan.
        </p>
      </div>
    );
  }

  if (state.kind === 'done') {
    return (
      <div className="glass" aria-live="polite">
        <h2 style={{ margin: '0 0 4px', fontSize: 22 }}>
          {state.crewName ? `You're in ${state.crewName}` : 'Your bubble is ready'}
        </h2>
        {state.bubbleNumber ? (
          <>
            <p className="lede">
              Your bubble is texting you now. Answer its four quick questions so it can plan around
              you.
            </p>
            <p className="number">{prettyPhone(state.bubbleNumber)}</p>
            {state.smsLink && (
              <>
                <p className="fine" style={{ textAlign: 'center' }}>
                  If nothing arrives in a minute, text your bubble.
                </p>
                <a className="button button-glass" href={state.smsLink}>
                  Text your bubble
                </a>
                <p className="fine" style={{ textAlign: 'center' }}>
                  On a laptop? Scan this with your phone.
                </p>
                <div className="qr">
                  <ClientQr
                    value={state.smsLink}
                    label="QR code that opens Messages to your bubble"
                  />
                </div>
              </>
            )}
          </>
        ) : (
          <p className="lede">
            You&apos;re signed up. Your bubble number is on its way; we&apos;ll text you when
            it&apos;s live.
          </p>
        )}
      </div>
    );
  }

  const error =
    state.kind === 'error' ? (
      <p className="error" role="alert">
        {state.message}
      </p>
    ) : null;

  if (crewCode && quick) {
    return (
      <form className="glass" onSubmit={quickJoin} noValidate>
        <label htmlFor="quick-phone">Your iPhone number</label>
        <input
          id="quick-phone"
          name="phone"
          type="tel"
          autoComplete="tel"
          inputMode="tel"
          placeholder="(704) 555-1234"
          required
        />
        {error}
        <button className="button" type="submit" disabled={state.kind === 'sending'}>
          {state.kind === 'sending' ? 'Joining...' : `Join ${crewName ?? 'the crew'}`}
        </button>
        <button
          className="button button-glass"
          type="button"
          onClick={() => {
            setQuick(false);
            setState({ kind: 'idle' });
          }}
        >
          New here? Get your bubble
        </button>
      </form>
    );
  }

  return (
    <form className="glass" onSubmit={submit} noValidate>
      <ol className="steps">
        <li>Sign up and get your own bubble number.</li>
        <li>Your bubble texts you. It learns what you eat, spend, and like.</li>
        <li>Tell it who your crew is. Then just text &ldquo;dinner tonight?&rdquo;</li>
      </ol>
      <label htmlFor="name">Name</label>
      <input
        id="name"
        name="name"
        autoComplete="name"
        placeholder="Ava Chen"
        maxLength={80}
        required
      />
      <label htmlFor="email">Email</label>
      <input
        id="email"
        name="email"
        type="email"
        autoComplete="email"
        placeholder="ava@example.com"
        required
      />
      <label htmlFor="phone">iPhone number</label>
      <input
        id="phone"
        name="phone"
        type="tel"
        autoComplete="tel"
        inputMode="tel"
        placeholder="(704) 555-1234"
        defaultValue={phoneHint ?? undefined}
        required
      />
      {error}
      <button className="button" type="submit" disabled={state.kind === 'sending'}>
        {state.kind === 'sending' ? 'Making your bubble...' : 'Get your bubble'}
      </button>
      {crewCode && (
        <button
          className="button button-glass"
          type="button"
          onClick={() => {
            setQuick(true);
            setState({ kind: 'idle' });
          }}
        >
          Already have a bubble? Just your number
        </button>
      )}
      <p className="fine">
        Bubbleworks works over iMessage. Your details stay with your bubble: nobody in your crew
        sees your budget, diet, or location. Text &ldquo;forget me&rdquo; any time to delete
        everything.
      </p>
    </form>
  );
}
