import { useEffect, useRef, useState } from "react";
import {
  sendChatMessage,
  getJob,
  getChatHistory,
  saveChatHistory,
  clearChatHistory,
  getVmTemplates,
  getContainerTemplates,
  getStacks,
  provisionVm,
  provisionContainer,
  provisionStack,
} from "../api/client.js";
import TerminalModal from "./TerminalModal.jsx";
import { useAuth } from "../context/AuthContext.jsx";
import { useLocation } from "react-router-dom";

const GREETING = {
  role: "assistant",
  text: "Tell me what to provision and I’ll return an editable proposal you can adjust before provisioning.",
};

const QUICK_PROMPTS = [
  "Propose a VM for LLM inference",
  "I want a container for stress test",
  "Suggest a stack for a small web app",
];

const DEFAULT_PACKAGES_BY_KIND = {
  vm: ["python", "nodejs"],
  container: ["python"],
  stack: ["python", "nodejs", "postgres"],
};

const PACKAGE_OPTIONS = [
  "ansible",
  "aqt",
  "awscli",
  "curl",
  "docker",
  "docker-compose",
  "dotnet-sdk",
  "git",
  "go",
  "grafana",
  "helm",
  "htop",
  "java",
  "jq",
  "kubectl",
  "maven",
  "mongodb",
  "mysql",
  "nginx",
  "nodejs",
  "openjdk",
  "php",
  "postman",
  "postgres",
  "prometheus",
  "python",
  "rabbitmq",
  "redis",
  "terraform",
  "tmux",
  "vim",
  "yarn",
];

function ChatPackageDropdown({ options, selected, onToggle }) {
  const [open, setOpen] = useState(true);
  const [query, setQuery] = useState("");
  const rootRef = useRef(null);

  useEffect(() => {
    const onDocClick = (e) => {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  const filtered = options.filter((pkg) => pkg.toLowerCase().includes(query.trim().toLowerCase()));

  return (
    <div className="chat-proposal-packages" ref={rootRef}>
      <button
        type="button"
        className="provision-select-trigger"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span>{selected.length ? `${selected.length} selected` : "Select packages"}</span>
        <span className="muted">{open ? "Hide" : "Show"}</span>
      </button>

      {open && (
        <div className="provision-select-menu">
          <input
            className="control-input provision-select-search"
            placeholder="Search packages..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="provision-select-list" role="listbox" aria-label="Additional package options">
            {filtered.map((pkg) => (
              <label key={pkg} className="provision-select-item">
                <input
                  type="checkbox"
                  checked={selected.includes(pkg)}
                  onChange={() => onToggle(pkg)}
                />
                <span>{pkg}</span>
              </label>
            ))}
            {filtered.length === 0 && <div className="muted">No matching packages</div>}
          </div>
        </div>
      )}
    </div>
  );
}

function ensureProposalShape(proposal, catalogs) {
  if (!proposal) return null;

  const additionalFromProposal = proposal.packageSelection?.additional || proposal.additionalPackages || [];

  if (proposal.kind === "stack") {
    const stack = catalogs.stacks.find((s) => s.id === proposal.stackId) || catalogs.stacks[0] || null;
    const defaults = DEFAULT_PACKAGES_BY_KIND.stack;
    const additionalPackages = additionalFromProposal.filter((pkg) => !defaults.includes(pkg));
    const packages = Array.from(new Set([...defaults, ...additionalPackages]));
    return {
      ...proposal,
      kind: "stack",
      stackId: proposal.stackId || stack?.id || "",
      stackName: proposal.stackName || stack?.name || "",
      hostnamePrefix: proposal.hostnamePrefix || "",
      cpu: proposal.cpu || 2,
      memoryGB: proposal.memoryGB || 2,
      diskGB: proposal.diskGB || 50,
      additionalPackages,
      packages,
    };
  }

  if (proposal.kind === "container") {
    const template = catalogs.containerTemplates.find((t) => t.id === proposal.templateId) || catalogs.containerTemplates[0] || null;
    const defaults = DEFAULT_PACKAGES_BY_KIND.container;
    const additionalPackages = additionalFromProposal.filter((pkg) => !defaults.includes(pkg));
    const packages = Array.from(new Set([...defaults, ...additionalPackages]));
    return {
      ...proposal,
      kind: "container",
      templateId: proposal.templateId || template?.id || "",
      templateName: proposal.templateName || template?.name || "",
      hostname: proposal.hostname || "",
      cpu: proposal.cpu || 2,
      memoryGB: proposal.memoryGB || 2,
      additionalPackages,
      packages,
    };
  }

  const template = catalogs.vmTemplates.find((t) => t.id === proposal.templateId) || catalogs.vmTemplates[0] || null;
  const defaults = DEFAULT_PACKAGES_BY_KIND.vm;
  const additionalPackages = additionalFromProposal.filter((pkg) => !defaults.includes(pkg));
  const packages = Array.from(new Set([...defaults, ...additionalPackages]));
  return {
    ...proposal,
    kind: "vm",
    templateId: proposal.templateId || template?.id || "",
    templateName: proposal.templateName || template?.name || "",
    hostname: proposal.hostname || "",
    cpu: proposal.cpu || 2,
    memoryGB: proposal.memoryGB || 2,
    diskGB: proposal.diskGB || 50,
    additionalPackages,
    packages,
  };
}

function ProposalEditor({ proposal, catalogs, busy, onChange, onProvision }) {
  const draft = ensureProposalShape(proposal, catalogs);

  if (!draft) return null;

  const vmTemplates = catalogs.vmTemplates;
  const containerTemplates = catalogs.containerTemplates;
  const stacks = catalogs.stacks;
  const recommendedDefaults = DEFAULT_PACKAGES_BY_KIND[draft.kind] || [];
  const additionalOptions = PACKAGE_OPTIONS.filter((pkg) => !recommendedDefaults.includes(pkg));
  const additionalPackages = (draft.additionalPackages || []).filter((pkg) => !recommendedDefaults.includes(pkg));
  const effectivePackages = Array.from(new Set([...recommendedDefaults, ...additionalPackages]));

  const update = (field) => (e) => {
    const value = e.target.type === "number" ? Number(e.target.value) : e.target.value;
    const next = { ...draft, [field]: value };

    if (field === "kind") {
      if (value === "stack") {
        const defaults = DEFAULT_PACKAGES_BY_KIND.stack;
        const nextStack = stacks.find((s) => s.id === next.stackId) || stacks[0] || null;
        next.stackId = nextStack?.id || "";
        next.stackName = nextStack?.name || "";
        next.hostnamePrefix = next.hostnamePrefix || "";
        next.additionalPackages = [];
        next.packages = defaults;
        delete next.templateId;
        delete next.templateName;
        delete next.hostname;
      } else if (value === "container") {
        const defaults = DEFAULT_PACKAGES_BY_KIND.container;
        const nextTemplate = containerTemplates.find((t) => t.id === next.templateId) || containerTemplates[0] || null;
        next.templateId = nextTemplate?.id || "";
        next.templateName = nextTemplate?.name || "";
        next.hostname = next.hostname || "";
        next.additionalPackages = [];
        next.packages = defaults;
        delete next.stackId;
        delete next.stackName;
        delete next.hostnamePrefix;
        delete next.diskGB;
      } else {
        const defaults = DEFAULT_PACKAGES_BY_KIND.vm;
        const nextTemplate = vmTemplates.find((t) => t.id === next.templateId) || vmTemplates[0] || null;
        next.kind = "vm";
        next.templateId = nextTemplate?.id || "";
        next.templateName = nextTemplate?.name || "";
        next.hostname = next.hostname || "";
        next.diskGB = next.diskGB || 50;
        next.additionalPackages = [];
        next.packages = defaults;
        delete next.stackId;
        delete next.stackName;
        delete next.hostnamePrefix;
      }
    }

    if (field === "templateId") {
      const selected = (value && (vmTemplates.find((t) => t.id === value) || containerTemplates.find((t) => t.id === value))) || null;
      next.templateName = selected?.name || value;
    }

    if (field === "stackId") {
      const selected = stacks.find((s) => s.id === value);
      next.stackName = selected?.name || value;
    }

    onChange(next);
  };

  const toggleAdditionalPackage = (pkg) => {
    const nextAdditional = additionalPackages.includes(pkg)
      ? additionalPackages.filter((p) => p !== pkg)
      : [...additionalPackages, pkg];
    const nextPackages = Array.from(new Set([...recommendedDefaults, ...nextAdditional]));
    onChange({
      ...draft,
      additionalPackages: nextAdditional,
      packages: nextPackages,
      packageSelection: {
        recommendedDefaults,
        additional: nextAdditional,
        selected: nextPackages,
        effective: nextPackages,
      },
    });
  };

  const hasIdentity = draft.kind === "stack"
    ? !!draft.stackId && draft.hostnamePrefix.trim().length > 0
    : !!draft.templateId && draft.hostname.trim().length > 0;
  const hasCpu = Number.isFinite(draft.cpu) && draft.cpu >= 1 && draft.cpu <= 32;
  const hasMemory = Number.isFinite(draft.memoryGB) && draft.memoryGB >= 1 && draft.memoryGB <= 256;
  const hasDisk = draft.kind === "container"
    ? true
    : Number.isFinite(draft.diskGB) && draft.diskGB >= 5 && draft.diskGB <= 2000;
  const canProvision = hasIdentity && hasCpu && hasMemory && hasDisk;

  return (
    <div className="chat-proposal">
      <div className="chat-proposal-head">
        <strong>Editable proposal</strong>
        <span className="chat-proposal-badge">{draft.kind === "stack" ? "Stack" : draft.kind === "container" ? "Container" : "VM"}</span>
      </div>

      <div className="field">
        <label>Resource type</label>
        <select value={draft.kind} onChange={update("kind")}>
          <option value="vm">Virtual machine</option>
          <option value="container">Container</option>
          <option value="stack">Stack</option>
        </select>
      </div>

      {draft.kind === "stack" ? (
        <>
          <div className="field">
            <label>Stack</label>
            <select value={draft.stackId} onChange={update("stackId")}>
              {stacks.length === 0 && <option value="">No stacks available</option>}
              {stacks.map((stack) => (
                <option key={stack.id} value={stack.id}>
                  {stack.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>Hostname prefix</label>
            <input value={draft.hostnamePrefix} onChange={update("hostnamePrefix")} placeholder="myapp" />
          </div>
        </>
      ) : (
        <>
          <div className="field">
            <label>{draft.kind === "container" ? "Container template" : "VM template"}</label>
            <select value={draft.templateId} onChange={update("templateId")}>
              {(draft.kind === "container" ? containerTemplates : vmTemplates).length === 0 && (
                <option value="">No templates available</option>
              )}
              {(draft.kind === "container" ? containerTemplates : vmTemplates).map((template) => (
                <option key={template.id} value={template.id}>
                  {template.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>Hostname</label>
            <input value={draft.hostname} onChange={update("hostname")} placeholder={draft.kind === "container" ? "my-ct-01" : "my-vm-01"} />
          </div>
        </>
      )}

      <div className="chat-proposal-grid">
        <div className="field">
          <label>CPU cores</label>
          <input type="number" min="1" max="32" value={draft.cpu} onChange={update("cpu")} />
        </div>
        <div className="field">
          <label>Memory (GB)</label>
          <input type="number" min="1" max="256" value={draft.memoryGB} onChange={update("memoryGB")} />
        </div>
        {draft.kind !== "container" && (
          <div className="field">
            <label>Disk size (GB)</label>
            <input type="number" min="5" max="2000" value={draft.diskGB} onChange={update("diskGB")} />
          </div>
        )}
      </div>

      <div className="field chat-proposal-defaults">
        <label>Default packages</label>
        <div className="provision-packages-list">
          {recommendedDefaults.map((pkg) => (
            <span key={pkg} className="provision-inline-kind provision-inline-kind-fixed">{pkg}</span>
          ))}
        </div>
      </div>

      <div className="field">
        <label>Additional packages</label>
        <ChatPackageDropdown
          options={additionalOptions}
          selected={additionalPackages}
          onToggle={toggleAdditionalPackage}
        />
      </div>

      <div className="field chat-proposal-defaults">
        <label>Will be installed</label>
        <div className="provision-packages-list">
          {effectivePackages.map((pkg) => (
            <span key={pkg} className="provision-inline-kind provision-inline-kind-final">{pkg}</span>
          ))}
        </div>
      </div>

      <div className="chat-proposal-actions">
        <button className="btn btn-primary btn-sm" disabled={busy || !canProvision} onClick={() => onProvision({
          ...draft,
          additionalPackages,
          packages: effectivePackages,
          packageSelection: {
            recommendedDefaults,
            additional: additionalPackages,
            selected: effectivePackages,
            effective: effectivePackages,
          },
        })}>
          {busy ? "Provisioning…" : "Provision from proposal"}
        </button>
      </div>
    </div>
  );
}

export default function ChatWidget({ onJobCreated = () => {} }) {
  const { user } = useAuth();
  const firstName = (user?.displayName || user?.username || "").split(/[\s.]/)[0];
  const greeting = (() => {
    const h = new Date().getHours();
    if (h < 12) return "Good morning";
    if (h < 18) return "Good afternoon";
    return "Good evening";
  })();
  const [open, setOpen] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  // Welcome bubble beside the icon. Shows once per page load / login — the
  // widget mounts at the app root and survives route changes, so this won't
  // re-fire as the user navigates within the app.
  const [showWelcome, setShowWelcome] = useState(true);
  const [welcomeEntered, setWelcomeEntered] = useState(false);
  const [welcomeLeaving, setWelcomeLeaving] = useState(false);
  const welcomeTimerRef = useRef(null);
  const [messages, setMessages] = useState([GREETING]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [provisioningIndex, setProvisioningIndex] = useState(null);
  const [connectTarget, setConnectTarget] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [catalogs, setCatalogs] = useState({ vmTemplates: [], containerTemplates: [], stacks: [] });
  const scrollRef = useRef(null);
  const inputRef = useRef(null);
  const prevCountRef = useRef(1);
  const panelRef = useRef(null);
  const location = useLocation();

  // Collapse the chat to its bubble when the user navigates to another page, so
  // it stays out of the way. Harmless while already closed.
  useEffect(() => {
    setOpen(false);
  }, [location.pathname]);

  // Collapse to the bubble when the user clicks anywhere outside the chat panel.
  useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (panelRef.current && !panelRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // Load persisted history once on mount.
  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const [history, vmTemplates, containerTemplates, stacks] = await Promise.all([
          getChatHistory(),
          getVmTemplates(),
          getContainerTemplates(),
          getStacks(),
        ]);

        if (cancelled) return;
        if (history.messages?.length) setMessages(history.messages);
        setCatalogs({ vmTemplates, containerTemplates, stacks });
      } catch {
        try {
          const history = await getChatHistory();
          if (cancelled) return;
          if (history.messages?.length) setMessages(history.messages);
        } catch {
          // ignore history/catalog load errors and fall back to defaults
        }
      } finally {
        if (!cancelled) setLoaded(true);
      }
    };

    load();

    return () => {
      cancelled = true;
    };
  }, []);

  // Persist whenever messages change (after the initial load), debounced.
  useEffect(() => {
    if (!loaded) return;
    const t = setTimeout(() => {
      saveChatHistory(messages).catch(() => {});
    }, 600);
    return () => clearTimeout(t);
  }, [messages, loaded]);

  const dismissWelcome = () => {
    clearTimeout(welcomeTimerRef.current);
    // Play the exit animation, then unmount.
    setWelcomeLeaving(true);
    welcomeTimerRef.current = setTimeout(() => setShowWelcome(false), 240);
  };

  const startWelcomeTimer = () => {
    clearTimeout(welcomeTimerRef.current);
    welcomeTimerRef.current = setTimeout(dismissWelcome, 9000);
  };
  const pauseWelcomeTimer = () => clearTimeout(welcomeTimerRef.current);

  // Let the bubble slide in a beat after login (feels intentional, not jarring
  // mid route-transition), then auto-dismiss after a few idle seconds.
  useEffect(() => {
    if (!showWelcome || open || welcomeLeaving) return undefined;
    if (!welcomeEntered) {
      const enter = setTimeout(() => setWelcomeEntered(true), 650);
      return () => clearTimeout(enter);
    }
    startWelcomeTimer();
    return () => clearTimeout(welcomeTimerRef.current);
  }, [showWelcome, open, welcomeEntered, welcomeLeaving]);

  const clearChat = async () => {
    setMessages([GREETING]);
    try { await clearChatHistory(); } catch (e) { /* ignore */ }
  };

  const provisionFromProposal = async (proposal, messageIndex) => {
    if (!proposal) return;
    setProvisioningIndex(messageIndex);
    try {
      let result;
      if (proposal.kind === "stack") {
        result = await provisionStack({
          stackId: proposal.stackId,
          hostnamePrefix: proposal.hostnamePrefix,
          cpu: proposal.cpu,
          memoryGB: proposal.memoryGB,
          diskGB: proposal.diskGB,
          packages: proposal.packages,
          packageSelection: proposal.packageSelection,
        });
      } else if (proposal.kind === "container") {
        result = await provisionContainer({
          templateId: proposal.templateId,
          hostname: proposal.hostname,
          cpu: proposal.cpu,
          memoryGB: proposal.memoryGB,
          packages: proposal.packages,
          packageSelection: proposal.packageSelection,
        });
      } else {
        result = await provisionVm({
          templateId: proposal.templateId,
          hostname: proposal.hostname,
          cpu: proposal.cpu,
          memoryGB: proposal.memoryGB,
          diskGB: proposal.diskGB,
          packages: proposal.packages,
          packageSelection: proposal.packageSelection,
        });
      }

      if (result?.job?.id) {
        setMessages((m) => [...m, { role: "assistant", text: `Provisioning started from your proposal. Tracking as job ${result.job.id}.` }]);
        onJobCreated?.(result.job.id);
        pollJobInChat(result.job.id);
      } else if (result?.request?.id) {
        setMessages((m) => [...m, { role: "assistant", text: `Request ${result.request.id} submitted and waiting for admin approval.` }]);
      }
    } catch (err) {
      const errText = err.response?.data?.error || err.message;
      setMessages((m) => [...m, { role: "assistant", text: `Error: ${errText}` }]);
    } finally {
      setProvisioningIndex(null);
    }
  };

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, open]);

  useEffect(() => {
    const prev = prevCountRef.current;
    if (messages.length > prev) {
      const newest = messages[messages.length - 1];
      if (newest?.role === "assistant" && !open) {
        setUnreadCount((n) => n + 1);
      }
    }
    prevCountRef.current = messages.length;
  }, [messages, open]);

  useEffect(() => {
    if (open) {
      setUnreadCount(0);
    }
  }, [open]);

  const pollJobInChat = (jobId) => {
    let lastStatus = null;
    let cancelled = false;

    const poll = async () => {
      if (cancelled) return;
      try {
        const job = await getJob(jobId);

        if (job.status !== lastStatus) {
          lastStatus = job.status;
          const msg = { role: "assistant", text: statusToChatLine(job) };
          // When ready, attach the resources so the bubble can show Connect buttons.
          if (job.status === "ready") {
            msg.resources = job.resources.filter((r) => r.ip);
          }
          setMessages((m) => [...m, msg]);
        }

        if (job.status === "ready" || job.status === "failed") {
          return; // stop polling
        }
      } catch (e) {
        // transient — keep trying
      }
      setTimeout(poll, 2500);
    };

    poll();
    return () => {
      cancelled = true;
    };
  };

  const statusToChatLine = (job) => {
    if (job.status === "failed") {
      return `Job ${job.id} failed: ${job.error || job.message}`;
    }
    if (job.status === "ready") {
      const lines = job.resources.map(
        (r) => `  - ${r.hostname} (VMID ${r.vmid}${r.role ? `, ${r.role}` : ""})${r.ip ? ` — IP ${r.ip}` : ""}`
      );
      return `Job ${job.id} is ready:\n${lines.join("\n")}`;
    }
    return `Job ${job.id}: ${job.message}`;
  };

  const send = async () => {
    const text = input.trim();
    if (!text || sending) return;

    const nextMessages = [...messages, { role: "user", text }];
    setMessages(nextMessages);
    setInput("");
    setSending(true);

    try {
      const history = nextMessages
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => ({ role: m.role, text: m.text }));

      const res = await sendChatMessage({ message: text, history });

      setMessages((m) => [
        ...m,
        {
          role: "assistant",
          text: res.reply,
          proposal: res.proposal ? ensureProposalShape(res.proposal, catalogs) : null,
        },
      ]);

      if (res.job) {
        onJobCreated?.(res.job.id);
        pollJobInChat(res.job.id);
      }
    } catch (err) {
      const errText = err.response?.data?.error || err.message;
      setMessages((m) => [...m, { role: "assistant", text: `Error: ${errText}` }]);
    } finally {
      setSending(false);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  if (!open) {
    return (
      <>
        {showWelcome && welcomeEntered && (
          <div
            className={`chat-welcome-pop${welcomeLeaving ? " chat-welcome-pop-leaving" : ""}`}
            role="status"
            onMouseEnter={pauseWelcomeTimer}
            onMouseLeave={startWelcomeTimer}
          >
            <button
              className="chat-welcome-close"
              onClick={dismissWelcome}
              aria-label="Dismiss welcome message"
            >
              ×
            </button>
            <div className="chat-welcome-title">{greeting}, {firstName || "there"} 👋</div>
            <div className="chat-welcome-text">
              I'm your provisioning assistant. Tell me what you'd like to spin up and
              I'll draft an editable proposal.
            </div>
            <button
              className="chat-welcome-cta"
              onClick={() => {
                dismissWelcome();
                setOpen(true);
              }}
            >
              Start chatting
            </button>
          </div>
        )}
        <button
          className="chat-bubble"
          onClick={() => {
            dismissWelcome();
            setOpen(true);
          }}
          aria-label="Open provisioning assistant"
          title="Provisioning Assistant"
        >
        <span className="chat-bubble-pulse" aria-hidden="true" />
        <svg
          className="chat-bubble-icon" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="3.4" r="1.2" />
          <path d="M12 4.6v3" />
          <rect x="4.5" y="7.6" width="15" height="11.4" rx="3" />
          <path d="M2.4 12.2v3M21.6 12.2v3" />
          <circle cx="9.2" cy="13" r="1.15" fill="currentColor" stroke="none" />
          <circle cx="14.8" cy="13" r="1.15" fill="currentColor" stroke="none" />
          <path d="M9.5 16.4h5" />
        </svg>
        <span className="chat-bubble-live" aria-hidden="true" title="Assistant online" />
        {unreadCount > 0 && <span className="chat-unread-badge">{unreadCount > 9 ? "9+" : unreadCount}</span>}
        </button>
      </>
    );
  }

  return (
    <div ref={panelRef} className="chat-panel">
      <div className="chat-panel-header">
        <span>Provisioning Assistant</span>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <button className="chat-clear-btn" onClick={clearChat} title="Clear chat history">Clear</button>
          <button
            className="chat-toggle-btn"
            onClick={() => setOpen(false)}
            title="Minimize to bubble"
            aria-label="Minimize chat to bubble"
          >
            −
          </button>
        </div>
      </div>

      {(
        <>
          <div className="chat-panel-body" ref={scrollRef}>
            {messages.map((m, i) => (
              <div key={i} className={`chat-msg chat-msg-${m.role}`}>
                <div>{m.text}</div>
                {m.proposal && (
                  <ProposalEditor
                    proposal={m.proposal}
                    catalogs={catalogs}
                    busy={provisioningIndex === i}
                    onChange={(nextProposal) => {
                      setMessages((current) =>
                        current.map((msg, idx) => (idx === i ? { ...msg, proposal: nextProposal } : msg))
                      );
                    }}
                    onProvision={(proposal) => provisionFromProposal(proposal, i)}
                  />
                )}
                {m.resources?.length > 0 && (
                  <div className="chat-connect-row">
                    {m.resources.map((r) => (
                      <button
                        key={r.vmid}
                        className="btn btn-primary btn-sm"
                        onClick={() => setConnectTarget({ vmid: r.vmid, ip: r.ip, hostname: r.hostname })}
                      >
                        Connect to {r.hostname}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))}
            {sending && <div className="chat-msg chat-msg-assistant chat-msg-pending">Thinking...</div>}

            {messages.length <= 2 && !sending && (
              <div className="chat-quick-prompts">
                {QUICK_PROMPTS.map((prompt) => (
                  <button
                    key={prompt}
                    className="chat-quick-btn"
                    onClick={() => {
                      setInput(prompt);
                      inputRef.current?.focus();
                    }}
                  >
                    {prompt}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="chat-panel-input">
            <textarea
              ref={inputRef}
              rows={2}
              placeholder="e.g. create a redhat vm with 1 cpu 1gb ram 50gb disk"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
            />
            <button className="btn btn-primary btn-sm" onClick={send} disabled={sending || !input.trim()}>
              Send
            </button>
          </div>
        </>
      )}

      {connectTarget && (
        <TerminalModal
          vmid={connectTarget.vmid}
          ip={connectTarget.ip}
          hostname={connectTarget.hostname}
          onClose={() => setConnectTarget(null)}
        />
      )}
    </div>
  );
}
