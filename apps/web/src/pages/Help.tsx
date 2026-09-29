import { useState } from "react";
import { navigate } from "../lib/router";
import { Icon } from "../components/Icons";

const FAQ: [string, string][] = [
  ["What's the difference between ORVYN Cloud and ORVYN Desktop?", "ORVYN Cloud is where you chat, keep projects and files, and manage your account from any browser. ORVYN Desktop runs missions on your computer — building apps, editing code and working in your folders. Both use the same account, projects, credits and billing."],
  ["How do credits work?", "Every request uses credits based on the work it takes. Your plan includes monthly credits plus rolling 5-hour and 7-day allowances that free up as earlier usage ages out. Top-up credits never expire and are used after your included credits."],
  ["Which model does AUTO use?", "AUTO picks the best ORVYN model for each request. You can also choose Fast, Reasoning, Code, Research or Vision from the model menu, or add your own model in Settings."],
  ["Do previews use credits?", "No. Opening a preview or downloading a file never calls a model and never uses credits."],
  ["Can I use my own model?", "Yes. In Settings → Models, add any OpenAI-compatible endpoint with your own key. Requests to it use your provider account."],
  ["How do I cancel or change my plan?", "Go to Billing and choose Manage billing. Changes are prorated; a cancelled plan stays active until the end of the period you paid for."],
  ["Who can see my chats and files?", "Only you. Workspace members can't open each other's conversations or the files in them, and nothing is shared between accounts."],
];

export function Help() {
  const [open, setOpen] = useState<number | null>(0);
  return (
    <>
      <h1 className="page-title">Help</h1>
      <p className="page-sub">Answers to common questions.</p>
      <div className="two" style={{ gridTemplateColumns: "minmax(0,2fr) minmax(0,1fr)" }}>
        <div>
          {FAQ.map(([q, a], i) => (
            <div key={q} className="card help-q" onClick={() => setOpen(open === i ? null : i)} role="button" aria-expanded={open === i}>
              <h4>{q} <Icon.down size={16} /></h4>
              {open === i ? <p>{a}</p> : null}
            </div>
          ))}
        </div>
        <div className="grid" style={{ alignContent: "start" }}>
          <section className="card card--pad">
            <div className="card__head"><Icon.chat size={22} /><h3>Ask ORVYN</h3></div>
            <p className="muted">Questions about using ORVYN? Ask in a chat.</p>
            <button className="btn btn--primary" onClick={() => navigate("/chats")}>New chat</button>
          </section>
          <section className="card card--pad">
            <div className="card__head"><Icon.help size={22} /><h3>Contact support</h3></div>
            <p className="muted">For billing or account issues, email <a href="mailto:support@virphoneusa.com">support@virphoneusa.com</a>.</p>
          </section>
        </div>
      </div>
    </>
  );
}
