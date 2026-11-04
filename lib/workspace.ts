import type { SellPipelineResult, OwnerPolicy, ListingDraft, SimulationResult, DealCard, AgentMessage, FindRequest, FindOffer } from "@/lib/types";
import { getAppState, mutateState } from "@/lib/db";
export type SavedSell = Omit<SellPipelineResult, "raw"> & { id: string; ownerPolicy: OwnerPolicy; voice: { transcript?: string } | null; approved: boolean; samplePhoto: boolean };
export type InboxState = { cards: DealCard[]; messages: AgentMessage[]; listing: ListingDraft | null; policy: OwnerPolicy | null; simulation: SimulationResult | null };
export type Workspace = { sell: SavedSell | null; inbox: InboxState; find: { requests: FindRequest[]; offers: FindOffer[] } };
export function emptyInbox(): InboxState { return { cards: [], messages: [], listing: null, policy: null, simulation: null }; }
export function emptyWorkspace(): Workspace { return { sell: null, inbox: emptyInbox(), find: { requests: [], offers: [] } }; }
export async function getWorkspace(sessionId: string): Promise<Workspace> { return await getAppState<Workspace>(`${sessionId}:workspace`) ?? emptyWorkspace(); }
export async function mutateWorkspace<R>(sessionId: string, update: (state: Workspace) => R) { return mutateState(`${sessionId}:workspace`, emptyWorkspace, update); }
