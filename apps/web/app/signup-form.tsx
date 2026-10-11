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

type State =
  | { kind: 'idle' }
  | { kind: 'sending' }
  | { kind: 'error'; message: string }
  | { kind: 'done'; bubbleNumber: string | null; smsLink: string | null; crewName: string | null };

export function SignupForm({ crewCode, crewName }: { crewCode?: string; crewName?: string } = {}) {
  const [state, setState] = useState<State>({ kind: 'idle' });

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

  if (state.kind === 'done') {
    return (
      <div className="glass" aria-live="polite">
        <h2 style={{ margin: '0 0 4px', fontSize: 22 }}>
          {state.crewName ? `You're in ${state.crewName}` : 'Your bubble is ready'}
        </h2>
        {state.bubbleNumber ? (
          <>
            <p className="lede">
              Text it to say hi. It will ask a few quick questions to get to know you.
            </p>
            <p className="number">{prettyPhone(state.bubbleNumber)}</p>
            {state.smsLink && (
              <>
                <a className="button" href={state.smsLink}>
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

  return (
    <form className="glass" onSubmit={submit} noValidate>
      <ol className="steps">
        <li>Sign up and get your own bubble number.</li>
        <li>Text your bubble. It learns what you eat, spend, and like.</li>
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
        required
      />
      {state.kind === 'error' && (
        <p className="error" role="alert">
          {state.message}
        </p>
      )}
      <button className="button" type="submit" disabled={state.kind === 'sending'}>
        {state.kind === 'sending' ? 'Making your bubble...' : 'Get your bubble'}
      </button>
      <p className="fine">
        Bubbleworks works over iMessage. Your details stay with your bubble: nobody in your crew
        sees your budget, diet, or location. Text &ldquo;forget me&rdquo; any time to delete
        everything.
      </p>
    </form>
  );
}
