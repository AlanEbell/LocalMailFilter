# LocalMailFilter (LMF)

A Thunderbird add-on that triages business spam and phishing into a **Look At Later**
folder using a local LLM served by [Ollama](https://ollama.com). Nothing leaves your
machine, and nothing is ever deleted.

## Why an add-on rather than a script

Running inside Thunderbird means it reuses Thunderbird's existing authentication.
No app passwords, no OAuth dance, no IMAP credentials stored anywhere — including
for Gmail and Google Workspace accounts, which otherwise need OAuth2 or app passwords.
Moves are performed by Thunderbird, so they sync back over IMAP and the sorted mail
also leaves the inbox on your phone.

## Design commitments

**Non-destructive by construction.** The add-on does not request the `messagesDelete`
permission, so it is incapable of deleting mail even if it malfunctions. It only ever
tags and moves. You delete manually after reviewing.

**Fully local.** The only network call is to `http://localhost:11434`. Message content
never leaves the machine.

**Zero idle GPU cost.** The model is held warm for the duration of a batch and then
explicitly unloaded, so VRAM returns to zero between runs. Verified against
`/api/ps` before and after each batch.

**You are always in control of the mode.** The add-on never changes its own behaviour.
At most it sends one notification suggesting the accuracy numbers look good.

## How it decides

Each message is rendered for the model as headers, authentication results, a
display-text-vs-real-host link table, and the first N characters of the body.
The classifier returns schema-constrained JSON (`category`, `evidence`,
`confidence`, `reason`), so parsing is deterministic rather than scraped from prose.

Two prompt rules do most of the work:

- **Direction of sale.** "Who is selling to whom" rather than "do I know them."
  Without this, a first-time customer emailing a public sales address gets flagged
  as cold outreach — the worst possible error for a business mailbox.
- **Legitimate is the default.** The model must cite concrete evidence to flag
  anything, and answers `legitimate` when it cannot.

Note that self-reported `confidence` from a small model is poorly calibrated — it
clusters near 0.95 regardless of difficulty. Confident mode therefore gates on
corroborating evidence count, not on the number alone.

## The learning allow-list

Move a message back out of Look At Later and the sender is allow-listed. Identity
keys are chosen in descending order of forgery resistance:

1. **DKIM signing domain** — cannot be forged, so this is preferred
2. **`List-Id`** — stable for newsletters whose envelope senders rotate
3. **Exact From address** — fallback

Shared bulk infrastructure (Gmail, SendGrid, SES, Mailchimp…) is never eligible as a
domain-level key, so trusting one Gmail correspondent does not trust all of Gmail.

Two important limits:

- An allow-list hit suppresses `business_spam` only. **Confident phishing is still
  flagged even for trusted senders**, because impersonating someone you trust is the
  entire mechanism of a phishing attack.
- Rescues also become few-shot counter-examples in the prompt, so the model learns the
  *pattern*, not just the individual sender.

Rescues performed on your phone do not fire Thunderbird's `onMoved` event, so a
periodic reconciliation sweep notices messages that left the folder on their own and
learns from those too.

## Modes

| Mode | Behaviour |
|---|---|
| `shadow` | Tags only, never moves. Still writes the daily report. |
| `confident` | Moves clear-cut calls; borderline stays in the inbox, listed as unsure. |
| `full` | Moves everything flagged. |

Start in `shadow`. The daily report tab has **Agree / Wrong** buttons per message;
those clicks are the only unambiguous accuracy signal, and "Wrong" runs the same
learning path as physically moving a message back. Once precision holds up, switch
modes yourself and optionally sweep the tagged backlog in one pass.

## Requirements

- Thunderbird 128+ (developed against 153 ESR)
- Ollama with a pulled model — `qwen3:8b` by default (~5 GB, ~1.5 s/message warm)
- A GPU is optional but pleasant; on an RTX 2080 Ti the model loads in ~3 s

## Install

```bash
sudo pacman -S ollama-cuda          # or your platform's ollama package
sudo systemctl enable --now ollama
ollama pull qwen3:8b

./build.sh
```

Then in Thunderbird: **Add-ons Manager → gear icon → Install Add-on From File →
`LocalMailFilter.xpi`**. Thunderbird does not require extension signing, so this
installs permanently.

Open the add-on's settings. Your name, addresses and accounts are read from
Thunderbird automatically, and role addresses such as `sales@` are recognised as
public inboxes so that strangers asking about products are treated as customers.

The only thing you supply is one line per domain saying what it *is* — a club, an
employer, your own business. Press **Fill in my domains** to get the scaffold. This
is stored locally and never in this repository, and it is the single biggest
accuracy lever: with it, an eight-case test suite covering cold outreach, a
first-time customer, a supplier invoice, a brand-impersonation phish and a
banking-detail-change scam classifies 8/8 correctly.

### Optional: free VRAM defensively

```ini
# /etc/systemd/system/ollama.service.d/10-keepalive.conf
[Service]
Environment="OLLAMA_KEEP_ALIVE=0"
Environment="OLLAMA_MAX_LOADED_MODELS=1"
```

The add-on unloads explicitly after every batch; this only guarantees the same for
anything else that talks to your Ollama instance.

## Layout

```
manifest.json      permissions and entry points
background.js      orchestration: queue, classify, act, learn, report
lib/prompt.txt     the classifier prompt (edit this, build.sh regenerates prompt.js)
lib/ollama.js      client; holds the model warm per batch, always unloads after
lib/extract.js     header/body/link extraction and DKIM identity keys
lib/allowlist.js   allow-list, suppression rules, few-shot corrections
lib/store.js       settings, verdict log, work queue, accuracy stats
lib/report.js      daily report rendering and mailing
ui/                settings page and interactive report tab
```

## License

MIT
