import type {
	AgentModel,
	AgentRuntimePort,
	AgentRuntimeStatus,
	AgentSession,
	AgentSessionSpec,
} from "../../../ports/outbound/agent-session-port";
import { ANTIGRAVITY_PROVIDER_ID } from "./acp-protocol";

export type CompositeAgentRuntimeInput = Readonly<{
	pi: AgentRuntimePort;
	antigravity?: AgentRuntimePort;
	preferAntigravityAuth: boolean;
}>;

// provider が antigravity のセッションを AntigravityAcpRuntime へ、それ以外を PiAgentRuntime へ振り分ける。
export class CompositeAgentRuntime implements AgentRuntimePort {
	readonly #pi: AgentRuntimePort;
	readonly #antigravity: AgentRuntimePort | undefined;
	readonly #preferAntigravityAuth: boolean;

	constructor(input: CompositeAgentRuntimeInput) {
		this.#pi = input.pi;
		this.#antigravity = input.antigravity;
		this.#preferAntigravityAuth = input.preferAntigravityAuth;
	}

	open(spec: AgentSessionSpec): AgentSession {
		if (spec.model.provider === ANTIGRAVITY_PROVIDER_ID) {
			if (this.#antigravity === undefined) {
				throw new Error(`Unknown model: ${spec.model.provider}/${spec.model.model}`);
			}
			return this.#antigravity.open(spec);
		}
		return this.#pi.open(spec);
	}

	listModels(): readonly AgentModel[] {
		return [...this.#pi.listModels(), ...(this.#antigravity?.listModels() ?? [])];
	}

	status(): AgentRuntimeStatus {
		const piStatus = this.#pi.status();
		if (this.#antigravity === undefined) {
			return piStatus;
		}
		const agyStatus = this.#antigravity.status();
		return {
			auth: this.#preferAntigravityAuth ? agyStatus.auth : piStatus.auth,
			usage: piStatus.usage,
			lastFailure: latestFailure(piStatus.lastFailure, agyStatus.lastFailure),
			sessions: [...piStatus.sessions, ...agyStatus.sessions],
		};
	}
}

function latestFailure(
	left: AgentRuntimeStatus["lastFailure"],
	right: AgentRuntimeStatus["lastFailure"],
): AgentRuntimeStatus["lastFailure"] {
	if (left == null) return right;
	if (right == null) return left;
	return left.at >= right.at ? left : right;
}
