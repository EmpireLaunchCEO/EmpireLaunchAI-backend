/**
 * DELETE /api/studio/creation/:id approval sweep — pure id-set computation.
 *
 * Each faceless/twin run writes ~5 approval rows: 1 x type=faceless (approved,
 * payload.assetId = project id) + N x type=video (completed, scene-level
 * assetIds) + ones keyed by payload.projectId. Deleting only the clicked row
 * leaves siblings that resurrect as ghost cards once their backing rows are
 * gone (owner Oct 9 defect). This helper computes the full deduped id set the
 * route sweeps with:
 *
 *   payload->>'assetId' = ANY(set) OR payload->>'projectId' = ANY(set)
 */
export function collectApprovalSweepIds(input: {
  creationId?: string | null;
  projectId?: string | null;
  sceneIds?: string[];
  approvalAssetId?: string | null;
  approvalProjectId?: string | null;
}): string[] {
  return [
    ...new Set(
      [
        input.creationId,
        input.projectId,
        ...(input.sceneIds ?? []),
        input.approvalAssetId,
        input.approvalProjectId,
      ].filter((x): x is string => !!x),
    ),
  ];
}