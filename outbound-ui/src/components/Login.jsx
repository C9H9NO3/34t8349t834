import React, { useState } from "react";

// Full-screen password gate shown when the hosted backend requires auth.
export default function Login({ onSubmit, error }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    await onSubmit(password);
    setBusy(false);
  }

  return (
    <div className="login-screen">
      <form className="login-card" onSubmit={submit}>
        <h1>Call Toolkit</h1>
        <p className="muted">Enter the dashboard password to continue.</p>
        <input
          className="login-input"
          type="password"
          placeholder="Password"
          value={password}
          autoFocus
          onChange={(e) => setPassword(e.target.value)}
        />
        {error ? <div className="login-error">{error}</div> : null}
        <button className="btn" type="submit" disabled={busy || !password}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
