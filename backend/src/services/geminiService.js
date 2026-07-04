import axios from "axios";
import { VM_TEMPLATES, CONTAINER_TEMPLATES, STACKS } from "../config/catalog.js";

const { GEMINI_API_KEY, GEMINI_MODEL = "gemini-2.5-flash" } = process.env;

const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const FUNCTION_DECLARATIONS = [
  {
    name: "resolve_provisioning",
    description: "Decide whether to provision immediately or return an editable proposal.",
    parameters: {
      type: "OBJECT",
      properties: {
        action: { type: "STRING", description: "Must be one of: provision, propose." },
        kind: { type: "STRING", description: "Must be one of: vm, container, stack." },
        templateId: { type: "STRING", description: "Template catalog id for vm/container proposals." },
        stackId: { type: "STRING", description: "Stack catalog id for stack proposals." },
        hostname: { type: "STRING", description: "Hostname for a vm/container proposal." },
        hostnamePrefix: { type: "STRING", description: "Hostname prefix for a stack proposal." },
        cpu: { type: "NUMBER", description: "Number of CPU cores." },
        memoryGB: { type: "NUMBER", description: "Memory in GB." },
        diskGB: { type: "NUMBER", description: "Disk size in GB." },
      },
      required: ["action", "kind"],
    },
  },
  {
    name: "manage_resources",
    description: "List assigned resources or run lifecycle actions on a specific VM/container.",
    parameters: {
      type: "OBJECT",
      properties: {
        action: { type: "STRING", description: "Must be one of: list_owned, status, reboot, shutdown, delete." },
        type: { type: "STRING", description: "Optional resource type filter/target: vm or container." },
        vmid: { type: "NUMBER", description: "Optional target VMID for action." },
        name: { type: "STRING", description: "Optional target resource name for action." },
      },
      required: ["action"],
    },
  },
];

function buildSystemInstruction() {
  const vmList = VM_TEMPLATES.map((t) => `  - id: "${t.id}", name: "${t.name}"`).join("\n");
  const containerList = CONTAINER_TEMPLATES.length
    ? CONTAINER_TEMPLATES.map((t) => `  - id: "${t.id}", name: "${t.name}"`).join("\n")
    : "  (none configured yet)";
  const stackList = STACKS.map((s) => `  - id: "${s.id}", name: "${s.name}" — ${s.description}`).join("\n");

  return `You are the provisioning assistant for an internal self-service cloud portal backed by Proxmox.
Users describe infrastructure they want in free text. Your job is to call exactly one of the
available functions (resolve_provisioning) to decide whether to provision immediately or return a proposal.

Available VM templates:
${vmList}

Available container templates:
${containerList}

Available stacks:
${stackList}

Rules:
- Map natural-language OS names to the correct templateId. "redhat", "rhel", "red hat" -> "rhel". "alpine", "linux" (generic) -> "alpine".
- If the user doesn't specify cpu, memoryGB, or diskGB, choose sensible defaults based on workload intent. Use larger defaults for heavier workloads (e.g., LLM/AI, stress/performance testing, databases) and smaller defaults for lightweight generic requests.
- If the user doesn't give a hostname, invent a short reasonable one based on the template, e.g. "rhel-vm-01".
- Choose the best-fit kind yourself: use stack for multi-component requests, container only when the user explicitly asks for container or lxc, and otherwise prefer vm.
- If the user explicitly asks for container/lxc/vm/stack, preserve that requested kind in the function args.
- If the request is ambiguous about which template (e.g. unknown OS), pick the closest available template rather than refusing.
- If the request is complete and unambiguous, set action to provision and include all needed fields so the backend can provision immediately.
- If the request is missing important details or likely benefits from review, set action to propose and include the editable resource fields so the user can adjust them.
- If the user only describes the use case or workload and does not give explicit resource details, prefer action=propose.
- Do not include any rationale or explanation field in the function call.
- If the message is not a provisioning request at all (e.g. small talk, a question about the portal), do not call any function — just reply normally in plain text.
- If the user asks to list resources assigned to them (e.g. "my VMs", "what is assigned to me"), call manage_resources with action=list_owned.
- If the user asks for status of a specific VM/container by name or vmid, call manage_resources with action=status and include name/vmid.
- If the user asks to reboot/shutdown/delete a VM/container, call manage_resources with action set accordingly and include vmid when available (preferred) or name.
- For lifecycle actions, include type when user specifies vm/container.
- Never call a function with a templateId or stackId that isn't in the lists above.`;
}

export async function chatWithGemini({ message, history = [] }) {
  if (!GEMINI_API_KEY || GEMINI_API_KEY === "CHANGE_ME") {
    throw new Error("GEMINI_API_KEY is not configured in backend/.env");
  }

  const contents = [
    ...history.map((h) => ({
      role: h.role === "assistant" ? "model" : "user",
      parts: [{ text: h.text }],
    })),
    { role: "user", parts: [{ text: message }] },
  ];

  const body = {
    contents,
    systemInstruction: { parts: [{ text: buildSystemInstruction() }] },
    tools: [{ functionDeclarations: FUNCTION_DECLARATIONS }],
  };

  const res = await axios.post(`${GEMINI_URL}?key=${GEMINI_API_KEY}`, body, {
    headers: { "Content-Type": "application/json" },
  });

  const candidate = res.data.candidates?.[0];
  const parts = candidate?.content?.parts || [];

  const functionCallPart = parts.find((p) => p.functionCall);
  const textPart = parts.find((p) => p.text);

  return {
    functionCall: functionCallPart?.functionCall || null, // { name, args }
    text: textPart?.text || null,
  };
}
