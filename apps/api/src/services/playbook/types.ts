/**
 * The playbook: what one workspace has learned about doing its own work.
 *
 * Three kinds, because the three things that went wrong in the run this was
 * built for are different in nature and want different phrasing:
 *
 * - `fact`    something true about the user's world that no tool reports.
 *             "The Plane workspace is at https://plane.example/hq" is a fact:
 *             the agent asked, was told once, and had nowhere to put it.
 * - `route`   how to accomplish something, named concretely. "To create a task
 *             in Plane, call plane__create_work_item with project_id and name."
 *             Replaces rediscovering the tool by search every single run.
 * - `pitfall` a dead end, recorded so it is not walked again. "There is no tool
 *             that returns a Plane workspace slug — ask the user for the URL."
 *             This is the one nothing in the system could previously express.
 */
export const BULLET_KINDS = ["fact", "route", "pitfall"] as const;
export type BulletKind = (typeof BULLET_KINDS)[number];

export type Bullet = {
  id: string;
  kind: BulletKind;
  content: string;
  helpful: number;
  harmful: number;
  createdAt: number;
  updatedAt: number;
};

/**
 * One change to the playbook.
 *
 * Deliberately small and deliberately incomplete: there is no operation that
 * replaces the playbook, and none that deletes a bullet. Both exist upstream
 * and both are how an evolving context dies — a model asked to rewrite the
 * whole thing compresses it to nothing, and a model allowed to delete prunes
 * the bullets it happens not to have used this run. Removal here is a decision
 * made by counters, or by the user in the UI, and never by the reflector.
 *
 * `revise` is the exception that proves it: it rewrites exactly one bullet
 * whose id the model had to name, bounded by the same length cap as an add.
 */
export type BulletDelta =
  | { op: "add"; kind: BulletKind; content: string }
  | { op: "revise"; id: string; content: string }
  | { op: "helpful"; id: string }
  | { op: "harmful"; id: string };

/** Longest a single bullet may be. A bullet is one idea; this is generous for one. */
export const MAX_BULLET_CHARS = 320;

/**
 * Most changes one run may make.
 *
 * A run that claims to have learned twenty things has not learned twenty
 * things; it has restated its transcript. The cap is what stops a single
 * unusual conversation from dominating the playbook, and it applies before
 * anything is written.
 */
export const MAX_DELTAS_PER_RUN = 5;
