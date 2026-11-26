import type {
	AgentModel,
	AgentRuntimePort,
	AgentRuntimeStatus,
	AgentSession,
	AgentSessionSpec,
	UsageSnapshot,
} from "../../../ports/outbound/agent-session-port";
import { ANTIGRAVITY_PROVIDER_ID } from "./acp-protocol";

export type CompositeAgentRuntimeInput = Readonly<{
	pi: AgentRuntimePort;
	antigravity?: AgentRuntimePort;
	preferAntigravityAuth: boolean;
	preferAntigravityUsage?: boolean;
}>;

// provider が antigravity のセッションを AntigravityAcpRuntime へ、それ以外を PiAgentRuntime へ振り分ける。
export class CompositeAgentRuntime implements AgentRuntimePort {
	readonly #pi: AgentRuntimePort;
	readonly #antigravity: AgentRuntimePort | undefined;
	readonly #preferAntigravityAuth: boolean;
	readonly #preferAntigravityUsage: boolean;

	constructor(input: CompositeAgentRuntimeInput) {
		this.#pi = input.pi;
		this.#antigravity = input.antigravity;
		this.#preferAntigravityAuth = input.preferAntigravityAuth;
		this.#preferAntigravityUsage = input.preferAntigravityUsage ?? input.preferAntigravityAuth;
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
		const usage = this.#preferAntigravityUsage
			? mergeUsageSnapshots(agyStatus.usage, piStatus.usage)
			: mergeUsageSnapshots(piStatus.usage, agyStatus.usage);
		return {
			auth: this.#preferAntigravityAuth ? agyStatus.auth : piStatus.auth,
			usage,
			lastFailure: latestFailure(piStatus.lastFailure, agyStatus.lastFailure),
			sessions: [...piStatus.sessions, ...agyStatus.sessions],
		};
	}
}

export function mergeUsageSnapshots(
	primary: UsageSnapshot | null,
	secondary: UsageSnapshot | null,
): UsageSnapshot | null {
	if (primary == null) return secondary;
	if (secondary == null) return primary;
	return {
		fetchedAt: primary.fetchedAt >= secondary.fetchedAt ? primary.fetchedAt : secondary.fetchedAt,
		planType: primary.planType ?? secondary.planType,
		limits: [...primary.limits, ...secondary.limits],
	};
}

function latestFailure(
	left: AgentRuntimeStatus["lastFailure"],
	right: AgentRuntimeStatus["lastFailure"],
): AgentRuntimeStatus["lastFailure"] {
	if (left == null) return right;
	if (right == null) return left;
	return left.at >= right.at ? left : right;
}
