"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export default function LoginPage() {
  const router = useRouter();
  const supabase = createClient();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMessage(null);

    if (mode === "signin") {
      const { error } = await supabase.auth.signInWithPassword({
        email,
        password,
      });
      if (error) setMessage(error.message);
      else {
        router.push("/");
        router.refresh();
      }
    } else {
      const { data, error } = await supabase.auth.signUp({ email, password });
      if (error) setMessage(error.message);
      else if (data.session) {
        router.push("/");
        router.refresh();
      } else {
        setMessage("Check your inbox to confirm your email, then sign in.");
      }
    }
    setBusy(false);
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className="card w-full max-w-sm">
        <h1 className="text-lg font-semibold mb-1">Trade Journal</h1>
        <p className="text-sm text-ink2 mb-5">
          {mode === "signin"
            ? "Sign in to your journal."
            : "Create an account. Your 45 starter tags are seeded automatically."}
        </p>
        <form onSubmit={submit} className="space-y-3">
          <div>
            <label className="label" htmlFor="email">
              Email
            </label>
            <input
              id="email"
              type="email"
              required
              className="input"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div>
            <label className="label" htmlFor="password">
              Password
            </label>
            <input
              id="password"
              type="password"
              required
              minLength={6}
              className="input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          {message && <p className="text-sm text-neg">{message}</p>}
          <button className="btn w-full" disabled={busy}>
            {busy ? "Working…" : mode === "signin" ? "Sign in" : "Sign up"}
          </button>
        </form>
        <button
          className="mt-4 text-sm text-ink2 underline"
          onClick={() => {
            setMode(mode === "signin" ? "signup" : "signin");
            setMessage(null);
          }}
        >
          {mode === "signin"
            ? "No account yet? Sign up"
            : "Already registered? Sign in"}
        </button>
      </div>
    </div>
  );
}
