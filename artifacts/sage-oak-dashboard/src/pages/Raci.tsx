import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useSearch } from "wouter";
import {
  useGetRaciMatrix,
  getGetRaciMatrixQueryKey,
  useCreateRaciRow,
  useUpdateRaciRow,
  useDeleteRaciRow,
  useCreateRaciMember,
  useUpdateRaciMember,
  useDeleteRaciMember,
  useSetRaciCell,
  useRenameRaciCategory,
  useListUserOptions,
  useListRaciAppOptions,
  useGetPublicAppSettings,
  type RaciTeamData,
  type RaciRow,
  type RaciMember,
  type RaciValue,
  type DropdownOption,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useActivityEventRefresh } from "@/hooks/useActivityEventRefresh";
import { useStoredId } from "@/hooks/useStoredId";
import { useStoredValue } from "@/hooks/useStoredValue";
import { useAuth } from "@/components/auth/AuthProvider";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  AlertTriangle,
  Download,
  ExternalLink,
  Link2,
  Pencil,
  Plus,
  Trash2,
  X,
} from "lucide-react";

const VALUE_META: Record<string, { label: string; className: string }> = {
  R: {
    label: "Responsible",
    className: "bg-red-100 text-red-900 dark:bg-red-900/40 dark:text-red-200",
  },
  A: {
    label: "Accountable",
    className:
      "bg-orange-100 text-orange-900 dark:bg-orange-900/40 dark:text-orange-200",
  },
  C: {
    label: "Consulted",
    className:
      "bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200",
  },
  I: {
    label: "Informed",
    className:
      "bg-emerald-100 text-emerald-900 dark:bg-emerald-900/40 dark:text-emerald-200",
  },
  "N/A": {
    label: "Not applicable",
    className: "bg-muted text-muted-foreground",
  },
};

// Fallback options used until the settings-driven list loads.
const DEFAULT_RACI_OPTIONS: DropdownOption[] = [
  { value: "R", label: "Responsible", active: true },
  { value: "A", label: "Accountable", active: true },
  { value: "C", label: "Consulted", active: true },
  { value: "I", label: "Informed", active: true },
  { value: "N/A", label: "Not applicable", active: true },
];

const RACI_PALETTE = [
  "bg-sky-100 text-sky-900 dark:bg-sky-900/40 dark:text-sky-200",
  "bg-violet-100 text-violet-900 dark:bg-violet-900/40 dark:text-violet-200",
  "bg-teal-100 text-teal-900 dark:bg-teal-900/40 dark:text-teal-200",
  "bg-rose-100 text-rose-900 dark:bg-rose-900/40 dark:text-rose-200",
  "bg-indigo-100 text-indigo-900 dark:bg-indigo-900/40 dark:text-indigo-200",
];

type RaciMeta = Record<string, { label: string; className: string }>;

/** Settings-driven RACI value options with color metadata and cycle order. */
function useRaciOptions() {
  const { data: settings } = useGetPublicAppSettings();
  return useMemo(() => {
    const options = settings?.raciValueOptions ?? DEFAULT_RACI_OPTIONS;
    const meta: RaciMeta = {};
    options.forEach((o, i) => {
      meta[o.value] = {
        label: o.label,
        className:
          VALUE_META[o.value]?.className ?? RACI_PALETTE[i % RACI_PALETTE.length]!,
      };
    });
    const cycle: (string | null)[] = [
      null,
      ...options.filter((o) => o.active).map((o) => o.value),
    ];
    return { options, meta, cycle };
  }, [settings]);
}

function Chip({ value, meta }: { value: string | null; meta?: RaciMeta }) {
  if (!value) return <span className="text-muted-foreground/40">·</span>;
  const m = (meta ?? VALUE_META)[value];
  return (
    <span
      className={`inline-flex h-6 min-w-8 items-center justify-center rounded px-1.5 text-xs font-semibold ${m?.className ?? "bg-muted"}`}
    >
      {value}
    </span>
  );
}

// Canonical fingerprint of a row's cell assignments, matching the server's
// expectedAssignments format: "memberId=value" sorted by memberId, joined
// with commas (empty string for no assignments).
function assignmentFingerprint(
  assignments: RaciRow["assignments"],
): string {
  return assignments
    .map((a) => ({ memberId: a.memberId, value: a.value }))
    .sort((a, b) => a.memberId - b.memberId)
    .map((a) => `${a.memberId}=${a.value}`)
    .join(",");
}

// Canonical fingerprint of a member's column assignments across all rows,
// matching the server's expectedAssignments format for member deletes:
// "rowId=value" sorted by rowId, joined with commas (empty string for no
// assignments).
function memberAssignmentFingerprint(
  rows: RaciRow[],
  memberId: number,
): string {
  return rows
    .flatMap((row) =>
      row.assignments
        .filter((a) => a.memberId === memberId)
        .map((a) => ({ rowId: row.id, value: a.value })),
    )
    .sort((a, b) => a.rowId - b.rowId)
    .map((a) => `${a.rowId}=${a.value}`)
    .join(",");
}

function rowWarnings(row: RaciRow): { multiA: boolean; noA: boolean } {
  const aCount = row.assignments.filter((a) => a.value === "A").length;
  return { multiA: aCount > 1, noA: aCount === 0 };
}

function NamePrompt({
  title,
  initial,
  open,
  onOpenChange,
  onSave,
  pending,
  label = "Name",
}: {
  title: string;
  initial: string;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onSave: (name: string) => void;
  pending: boolean;
  label?: string;
}) {
  const [name, setName] = useState(initial);
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (o) setName(initial);
        onOpenChange(o);
      }}
    >
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label>{label}</Label>
          <Input
            value={name}
            autoFocus
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && name.trim()) onSave(name.trim());
            }}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => name.trim() && onSave(name.trim())} disabled={pending || !name.trim()}>
            {pending ? "Saving..." : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const NO_APP = "__none__";

function LinkAppDialog({
  row,
  open,
  onOpenChange,
  onSave,
  pending,
}: {
  row: RaciRow;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onSave: (applicationId: number | null) => void;
  pending: boolean;
}) {
  const { data: apps, isLoading } = useListRaciAppOptions();
  const [selected, setSelected] = useState<string>(
    row.applicationId != null ? String(row.applicationId) : NO_APP,
  );
  const applicationId = selected === NO_APP ? null : Number(selected);
  const unchanged = applicationId === (row.applicationId ?? null);
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (o)
          setSelected(
            row.applicationId != null ? String(row.applicationId) : NO_APP,
          );
        onOpenChange(o);
      }}
    >
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Linked app for "{row.name}"</DialogTitle>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label>Application</Label>
          <Select value={selected} onValueChange={setSelected}>
            <SelectTrigger aria-label="Linked application">
              <SelectValue
                placeholder={isLoading ? "Loading apps..." : "Choose an app"}
              />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_APP}>None (no linked app)</SelectItem>
              {(apps ?? []).map((a) => (
                <SelectItem key={a.id} value={String(a.id)}>
                  {a.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            Linking shows this task's role assignments as chips on the
            Rostering board for that app.
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => onSave(applicationId)} disabled={pending || unchanged}>
            {pending ? "Saving..." : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const CUSTOM_MEMBER = "__custom__";

function AddMemberDialog({
  teamName,
  existingNames,
  open,
  onOpenChange,
  onSave,
  pending,
}: {
  teamName: string;
  existingNames: string[];
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onSave: (name: string) => void;
  pending: boolean;
}) {
  const { data: userOptions, isLoading } = useListUserOptions();
  const [selected, setSelected] = useState<string>("");
  const [customName, setCustomName] = useState("");

  const taken = useMemo(
    () => new Set(existingNames.map((n) => n.trim().toLowerCase())),
    [existingNames],
  );
  const itUsers = useMemo(
    () =>
      (userOptions ?? []).filter((u) =>
        u.tags.some((t) => t.trim().toLowerCase() === "it"),
      ),
    [userOptions],
  );
  const noneTagged = !isLoading && itUsers.length === 0;
  const choices = useMemo(
    () =>
      itUsers.filter((u) => !taken.has(u.displayName.trim().toLowerCase())),
    [itUsers, taken],
  );

  const name =
    selected === CUSTOM_MEMBER ? customName.trim() : selected.trim();

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (o) {
          setSelected("");
          setCustomName("");
        }
        onOpenChange(o);
      }}
    >
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Add member to {teamName}</DialogTitle>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label>Member</Label>
          <Select value={selected} onValueChange={setSelected}>
            <SelectTrigger>
              <SelectValue
                placeholder={isLoading ? "Loading users..." : "Choose a person"}
              />
            </SelectTrigger>
            <SelectContent>
              {choices.map((u) => (
                <SelectItem key={u.id} value={u.displayName}>
                  {u.displayName}
                </SelectItem>
              ))}
              <SelectItem value={CUSTOM_MEMBER}>
                Someone else (type a name)...
              </SelectItem>
            </SelectContent>
          </Select>
          {noneTagged && (
            <p className="text-xs text-muted-foreground">
              No users are tagged "IT" yet. Tag them on the Users page to list
              them here.
            </p>
          )}
        </div>
        {selected === CUSTOM_MEMBER && (
          <div className="space-y-1.5">
            <Label>Name</Label>
            <Input
              value={customName}
              autoFocus
              onChange={(e) => setCustomName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && name) onSave(name);
              }}
            />
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => name && onSave(name)} disabled={pending || !name}>
            {pending ? "Saving..." : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TeamMatrix({
  team,
  highlightAppId,
}: {
  team: RaciTeamData;
  highlightAppId: number | null;
}) {
  const { isAdmin } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [, setLocation] = useLocation();
  // Remembered across refresh (and shared across teams) so admins doing long
  // sessions keep their filter. localStorage only stores strings, so any
  // stored value is a valid search; the empty default clears the key.
  const [search, setSearch] = useStoredValue(
    "sageoak-raci-search",
    "",
    (raw) => raw,
  );
  const { meta: raciMeta, cycle } = useRaciOptions();

  const setCell = useSetRaciCell();
  const createRow = useCreateRaciRow();
  const updateRow = useUpdateRaciRow();
  const deleteRow = useDeleteRaciRow();
  const createMember = useCreateRaciMember();
  const updateMember = useUpdateRaciMember();
  const deleteMember = useDeleteRaciMember();
  const renameCategory = useRenameRaciCategory();

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: getGetRaciMatrixQueryKey() });
  const onError = (err: any) =>
    toast({
      title: "Action failed",
      description: err?.data?.message ?? "Try again.",
      variant: "destructive",
    });
  // Shared 409 handling for rename conflicts: another admin changed the same
  // name since we loaded it, so refresh instead of overwriting their edit.
  const onRenameError = (close: () => void) => (err: any) => {
    if (err?.status === 409) {
      const currentName = err?.data?.currentName;
      const removed = err?.data?.removed === true;
      toast({
        title: "Changed by another admin",
        description: removed
          ? "This was just removed by someone else. The matrix has been refreshed."
          : currentName
            ? `This was just renamed by someone else. It is now called "${currentName}". The matrix has been refreshed — try again if you still want to change it.`
            : "This was just renamed by someone else. The matrix has been refreshed — try again if you still want to change it.",
      });
      invalidate();
      close();
      return;
    }
    onError(err);
  };
  // Shared 409 handling for delete conflicts: another admin renamed this item
  // or changed its assignments since we loaded it, so refresh instead of
  // destroying their change blindly.
  const onDeleteConflict = (err: any) => {
    if (err?.status === 409) {
      const changedAssignments =
        typeof err?.data?.message === "string" &&
        err.data.message.includes("assignments");
      toast({
        title: "Changed by another admin",
        description: changedAssignments
          ? "Its assignments were just changed by someone else. The matrix has been refreshed — review the changes and delete again if you still want to."
          : "This was just renamed by someone else. The matrix has been refreshed — check the new name and delete again if you still want to.",
      });
      invalidate();
      return;
    }
    onError(err);
  };

  const [editRow, setEditRow] = useState<RaciRow | null>(null);
  const [linkRow, setLinkRow] = useState<RaciRow | null>(null);
  const [editMember, setEditMember] = useState<RaciMember | null>(null);
  const [editCategory, setEditCategory] = useState<string | null>(null);
  const [addRowCategory, setAddRowCategory] = useState<string | null | false>(false);
  const [addMemberOpen, setAddMemberOpen] = useState(false);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return team.rows;
    const matchingMemberIds = new Set(
      team.members.filter((m) => m.name.toLowerCase().includes(q)).map((m) => m.id),
    );
    return team.rows.filter(
      (r) =>
        r.name.toLowerCase().includes(q) ||
        (r.category ?? "").toLowerCase().includes(q) ||
        r.assignments.some(
          (a) => matchingMemberIds.has(a.memberId) && a.value !== "N/A",
        ),
    );
  }, [team, search]);

  // Preserve row order while grouping consecutive categories.
  const groups = useMemo(() => {
    const out: { category: string | null; rows: RaciRow[] }[] = [];
    for (const row of filtered) {
      const last = out[out.length - 1];
      if (last && last.category === (row.category ?? null)) last.rows.push(row);
      else out.push({ category: row.category ?? null, rows: [row] });
    }
    return out;
  }, [filtered]);

  const cycleCell = (row: RaciRow, memberId: number) => {
    if (!isAdmin) return;
    const current =
      (row.assignments.find((a) => a.memberId === memberId)?.value as RaciValue | undefined) ??
      null;
    // Cycle through blank + active options; unknown (deactivated) current
    // values cycle back to blank first.
    const idx = cycle.indexOf(current);
    const next = cycle[(idx + 1) % cycle.length] ?? null;
    setCell.mutate(
      // expectedValue lets the server reject the update if another admin
      // changed this cell since we loaded it (409), instead of overwriting.
      { data: { rowId: row.id, memberId, value: next, expectedValue: current } },
      {
        onSuccess: invalidate,
        onError: (err: any) => {
          if (err?.status === 409) {
            const currentValue = err?.data?.currentValue;
            toast({
              title: "Cell changed by another admin",
              description:
                currentValue !== undefined
                  ? `This cell was just updated by someone else. It is now ${
                      currentValue == null ? "empty" : `"${currentValue}"`
                    }. The matrix has been refreshed — click again to change it.`
                  : "This cell was just updated by someone else. The matrix has been refreshed — click again to change it.",
            });
            invalidate();
            return;
          }
          onError(err);
        },
      },
    );
  };

  const exportCsv = async () => {
    try {
      const res = await fetch(
        `${import.meta.env.BASE_URL}api/raci/teams/${team.id}/export`,
        { credentials: "include" },
      );
      if (!res.ok) throw new Error(`Export failed (${res.status})`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `raci-${team.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast({
        title: "Download failed",
        description: err instanceof Error ? err.message : "Please try again.",
        variant: "destructive",
      });
    }
  };

  const flaggedRows = team.rows.filter((r) => rowWarnings(r).multiA).length;
  const unassignedRows = team.rows.filter((r) => rowWarnings(r).noA).length;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          placeholder="Search tasks, categories, or people..."
          className="max-w-xs"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          {Object.entries(raciMeta).map(([v, m]) => (
            <span key={v} className="inline-flex items-center gap-1">
              <Chip value={v} meta={raciMeta} />
              <span className="text-muted-foreground">{m.label}</span>
            </span>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-2">
          {isAdmin && (
            <Button size="sm" variant="outline" onClick={() => setAddMemberOpen(true)}>
              <Plus className="h-4 w-4 mr-1" /> Member
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={exportCsv}>
            <Download className="h-4 w-4 mr-1" /> CSV
          </Button>
        </div>
      </div>

      {(flaggedRows > 0 || unassignedRows > 0) && (
        <div className="flex flex-wrap gap-2 text-xs">
          {flaggedRows > 0 && (
            <Badge
              variant="outline"
              className="border-transparent bg-red-100 text-red-900 dark:bg-red-900/40 dark:text-red-200"
            >
              <AlertTriangle className="h-3 w-3 mr-1" />
              {flaggedRows} task{flaggedRows === 1 ? "" : "s"} with more than one
              Accountable
            </Badge>
          )}
          {unassignedRows > 0 && (
            <Badge
              variant="outline"
              className="border-transparent bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200"
            >
              {unassignedRows} task{unassignedRows === 1 ? "" : "s"} with no
              Accountable
            </Badge>
          )}
        </div>
      )}

      {isAdmin && (
        <p className="text-xs text-muted-foreground">
          Click a cell to cycle its value (blank → R → A → C → I → N/A). Click
          names and categories to rename them.
        </p>
      )}

      <Card>
        <CardContent className="p-0 overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="min-w-64">Decision or Task</TableHead>
                {team.members.map((m) => (
                  <TableHead key={m.id} className="text-center whitespace-nowrap">
                    {isAdmin ? (
                      <span className="inline-flex items-center gap-1">
                        <button
                          className="hover:underline"
                          onClick={() => setEditMember(m)}
                          title="Rename member"
                        >
                          {m.name}
                        </button>
                        <button
                          className="text-muted-foreground hover:text-destructive"
                          aria-label={`Remove ${m.name}`}
                          onClick={() => {
                            if (
                              window.confirm(
                                `Remove ${m.name} from ${team.name}? Their assignments will be deleted.`,
                              )
                            ) {
                              deleteMember.mutate(
                                // expectedName / expectedAssignments let the
                                // server reject the delete (409) if another
                                // admin renamed this member or changed their
                                // column assignments since we loaded the
                                // matrix.
                                {
                                  id: m.id,
                                  params: {
                                    expectedName: m.name,
                                    expectedAssignments:
                                      memberAssignmentFingerprint(
                                        team.rows,
                                        m.id,
                                      ),
                                  },
                                },
                                {
                                  onSuccess: invalidate,
                                  onError: onDeleteConflict,
                                },
                              );
                            }
                          }}
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </span>
                    ) : (
                      m.name
                    )}
                  </TableHead>
                ))}
                {isAdmin && <TableHead className="w-20 text-right">Actions</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {groups.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={team.members.length + (isAdmin ? 2 : 1)}
                    className="py-8 text-center text-muted-foreground"
                  >
                    {/* Empty-state text is asserted by scripts/src/staff-ui-check.ts — keep in sync. */}
                    {search ? (
                      <span className="flex flex-col items-center gap-2">
                        <span>No tasks match your search.</span>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setSearch("")}
                        >
                          Clear search
                        </Button>
                      </span>
                    ) : (
                      "No tasks yet for this team."
                    )}
                  </TableCell>
                </TableRow>
              )}
              {groups.map((group, gi) => (
                <GroupRows
                  key={`${group.category ?? "none"}-${gi}`}
                  group={group}
                  team={team}
                  isAdmin={isAdmin}
                  raciMeta={raciMeta}
                  onCycle={cycleCell}
                  onEditRow={setEditRow}
                  onDeleteRow={(row) => {
                    if (window.confirm(`Remove "${row.name}" from the matrix?`)) {
                      deleteRow.mutate(
                        // expectedName / expectedAssignments let the server
                        // reject the delete (409) if another admin renamed
                        // this task or changed its cell assignments since we
                        // loaded the matrix.
                        {
                          id: row.id,
                          params: {
                            expectedName: row.name,
                            expectedAssignments: assignmentFingerprint(
                              row.assignments,
                            ),
                          },
                        },
                        { onSuccess: invalidate, onError: onDeleteConflict },
                      );
                    }
                  }}
                  onRenameCategory={setEditCategory}
                  onAddRow={(category) => setAddRowCategory(category)}
                  onOpenApp={() => setLocation("/rostering")}
                  onLinkApp={setLinkRow}
                  highlightAppId={highlightAppId}
                />
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {isAdmin && (
        <Button size="sm" variant="outline" onClick={() => setAddRowCategory(null)}>
          <Plus className="h-4 w-4 mr-1" /> Add task
        </Button>
      )}

      {linkRow && (
        <LinkAppDialog
          row={linkRow}
          open={linkRow != null}
          onOpenChange={(o) => !o && setLinkRow(null)}
          pending={updateRow.isPending}
          onSave={(applicationId) =>
            updateRow.mutate(
              { id: linkRow.id, data: { applicationId } },
              {
                onSuccess: () => {
                  invalidate();
                  setLinkRow(null);
                  toast({
                    title:
                      applicationId != null
                        ? "App linked"
                        : "App link cleared",
                    description:
                      applicationId != null
                        ? `"${linkRow.name}" now shows its role chips on the Rostering board.`
                        : `"${linkRow.name}" is no longer linked to an app.`,
                  });
                },
                onError,
              },
            )
          }
        />
      )}
      {editRow && (
        <NamePrompt
          title="Rename task"
          initial={editRow.name}
          open={editRow != null}
          onOpenChange={(o) => !o && setEditRow(null)}
          pending={updateRow.isPending}
          onSave={(name) =>
            updateRow.mutate(
              // expectedName lets the server reject the rename (409) if
              // another admin renamed this task since we loaded it.
              { id: editRow.id, data: { name, expectedName: editRow.name } },
              {
                onSuccess: () => {
                  invalidate();
                  setEditRow(null);
                },
                onError: onRenameError(() => setEditRow(null)),
              },
            )
          }
        />
      )}
      {editMember && (
        <NamePrompt
          title="Rename member"
          initial={editMember.name}
          open={editMember != null}
          onOpenChange={(o) => !o && setEditMember(null)}
          pending={updateMember.isPending}
          onSave={(name) =>
            updateMember.mutate(
              // expectedName lets the server reject the rename (409) if
              // another admin renamed this member since we loaded it.
              {
                id: editMember.id,
                data: { name, expectedName: editMember.name },
              },
              {
                onSuccess: () => {
                  invalidate();
                  setEditMember(null);
                },
                onError: onRenameError(() => setEditMember(null)),
              },
            )
          }
        />
      )}
      {editCategory != null && (
        <NamePrompt
          title={`Rename category "${editCategory}"`}
          initial={editCategory}
          open={editCategory != null}
          onOpenChange={(o) => !o && setEditCategory(null)}
          pending={renameCategory.isPending}
          onSave={(to) =>
            renameCategory.mutate(
              // "from" doubles as the expected value: the server returns 409
              // if the category was renamed or removed by another admin.
              { id: team.id, data: { from: editCategory, to } },
              {
                onSuccess: () => {
                  invalidate();
                  setEditCategory(null);
                },
                onError: onRenameError(() => setEditCategory(null)),
              },
            )
          }
        />
      )}
      {addRowCategory !== false && (
        <NamePrompt
          title={
            addRowCategory
              ? `Add task under ${addRowCategory}`
              : "Add task"
          }
          label="Task name"
          initial=""
          open={true}
          onOpenChange={(o) => !o && setAddRowCategory(false)}
          pending={createRow.isPending}
          onSave={(name) =>
            createRow.mutate(
              {
                data: {
                  teamId: team.id,
                  name,
                  category: addRowCategory || null,
                },
              },
              {
                onSuccess: () => {
                  invalidate();
                  setAddRowCategory(false);
                },
                onError,
              },
            )
          }
        />
      )}
      <AddMemberDialog
        teamName={team.name}
        existingNames={team.members.map((m) => m.name)}
        open={addMemberOpen}
        onOpenChange={setAddMemberOpen}
        pending={createMember.isPending}
        onSave={(name) =>
          createMember.mutate(
            { data: { teamId: team.id, name } },
            {
              onSuccess: () => {
                invalidate();
                setAddMemberOpen(false);
              },
              onError,
            },
          )
        }
      />
    </div>
  );
}

function GroupRows({
  group,
  team,
  isAdmin,
  raciMeta,
  onCycle,
  onEditRow,
  onDeleteRow,
  onRenameCategory,
  onAddRow,
  onOpenApp,
  onLinkApp,
  highlightAppId,
}: {
  group: { category: string | null; rows: RaciRow[] };
  team: RaciTeamData;
  isAdmin: boolean;
  raciMeta: RaciMeta;
  onCycle: (row: RaciRow, memberId: number) => void;
  onEditRow: (row: RaciRow) => void;
  onDeleteRow: (row: RaciRow) => void;
  onRenameCategory: (category: string) => void;
  onAddRow: (category: string | null) => void;
  onOpenApp: () => void;
  onLinkApp: (row: RaciRow) => void;
  highlightAppId: number | null;
}) {
  const colSpan = team.members.length + (isAdmin ? 2 : 1);
  const highlightRef = useRef<HTMLTableRowElement | null>(null);
  useEffect(() => {
    if (highlightRef.current) {
      highlightRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [highlightAppId]);
  return (
    <>
      {group.category && (
        <TableRow className="bg-violet-100/70 hover:bg-violet-100/70 dark:bg-violet-900/30 dark:hover:bg-violet-900/30">
          <TableCell colSpan={colSpan} className="py-1.5">
            <span className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-violet-900 dark:text-violet-200">
              {isAdmin ? (
                <button
                  className="hover:underline uppercase"
                  onClick={() => onRenameCategory(group.category!)}
                  title="Rename category"
                >
                  {group.category}
                </button>
              ) : (
                group.category
              )}
              {isAdmin && (
                <button
                  className="text-violet-700 hover:text-violet-900 dark:text-violet-300"
                  aria-label={`Add task under ${group.category}`}
                  onClick={() => onAddRow(group.category)}
                >
                  <Plus className="h-3.5 w-3.5" />
                </button>
              )}
            </span>
          </TableCell>
        </TableRow>
      )}
      {group.rows.map((row) => {
        const warnings = rowWarnings(row);
        const byMember = new Map(row.assignments.map((a) => [a.memberId, a.value]));
        const highlighted =
          highlightAppId != null && row.applicationId === highlightAppId;
        return (
          <TableRow
            key={row.id}
            ref={highlighted ? highlightRef : undefined}
            data-highlighted={highlighted || undefined}
            className={
              highlighted
                ? "bg-sky-100/80 hover:bg-sky-100/80 dark:bg-sky-900/40 dark:hover:bg-sky-900/40 transition-colors duration-1000"
                : "transition-colors duration-1000"
            }
          >
            <TableCell>
              <div className="flex items-center gap-1.5">
                <span className="font-medium">{row.name}</span>
                {row.applicationId != null ? (
                  <span className="inline-flex items-center gap-0.5">
                    <button
                      className="inline-flex items-center gap-0.5 text-xs text-sky-700 hover:underline dark:text-sky-400"
                      onClick={onOpenApp}
                      title={`Linked to ${row.appName ?? "an app"} — open the Rostering board`}
                    >
                      <ExternalLink className="h-3 w-3" />
                      {row.appName ?? "Rostering"}
                    </button>
                    {isAdmin && (
                      <button
                        className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                        aria-label={`Change linked app for ${row.name}`}
                        title="Change or clear the linked app"
                        onClick={() => onLinkApp(row)}
                      >
                        <Link2 className="h-3 w-3" />
                      </button>
                    )}
                  </span>
                ) : isAdmin ? (
                  <button
                    className="inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
                    aria-label={`Link ${row.name} to an app`}
                    title="Link this task to an app so its role chips show on the Rostering board"
                    onClick={() => onLinkApp(row)}
                  >
                    <Link2 className="h-3 w-3" />
                    Link app
                  </button>
                ) : null}
                {warnings.multiA && (
                  <span
                    title="More than one person is Accountable for this task"
                    aria-label="Multiple Accountable"
                  >
                    <AlertTriangle className="h-3.5 w-3.5 text-red-600 dark:text-red-400" />
                  </span>
                )}
                {warnings.noA && (
                  <Badge
                    variant="outline"
                    className="h-4 border-transparent bg-amber-100 px-1.5 text-[10px] text-amber-900 dark:bg-amber-900/40 dark:text-amber-200"
                  >
                    No A
                  </Badge>
                )}
              </div>
            </TableCell>
            {team.members.map((m) => {
              const value = byMember.get(m.id) ?? null;
              return (
                <TableCell key={m.id} className="text-center">
                  {isAdmin ? (
                    <button
                      className="rounded p-0.5 hover:bg-muted"
                      onClick={() => onCycle(row, m.id)}
                      aria-label={`${m.name} on ${row.name}: ${value ?? "blank"}`}
                    >
                      <Chip value={value} meta={raciMeta} />
                    </button>
                  ) : (
                    <Chip value={value} meta={raciMeta} />
                  )}
                </TableCell>
              );
            })}
            {isAdmin && (
              <TableCell>
                <div className="flex items-center justify-end gap-0.5">
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7"
                    aria-label={`Rename ${row.name}`}
                    onClick={() => onEditRow(row)}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7 text-muted-foreground hover:text-destructive"
                    aria-label={`Delete ${row.name}`}
                    onClick={() => onDeleteRow(row)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </TableCell>
            )}
          </TableRow>
        );
      })}
    </>
  );
}

function MissingRowNotice({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div
      role="status"
      data-testid="raci-missing-row-notice"
      className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-900/30 dark:text-amber-200"
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <span className="flex-1">
        That application no longer has a RACI row — it may have been removed
        from the matrix.
      </span>
      <button
        className="rounded p-0.5 hover:bg-amber-100 dark:hover:bg-amber-900/50"
        aria-label="Dismiss notice"
        onClick={onDismiss}
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

export default function Raci() {
  const { data, isLoading } = useGetRaciMatrix();
  // Live-update the matrix when another admin edits it (RACI changes are
  // emitted on the shared rostering activity stream).
  useActivityEventRefresh(getGetRaciMatrixQueryKey());
  const teams = data?.teams ?? [];
  const [storedTeamId, setStoredTeamId] = useStoredId("sageoak-raci-team");
  const [selectedTeamId, setSelectedTeamIdState] = useState<number | null>(null);
  const setSelectedTeamId = (id: number) => {
    setSelectedTeamIdState(id);
    setStoredTeamId(id);
  };

  // ?app=<applicationId> (from a RACI chip on Issues/Rostering) jumps to the
  // row for that application: pick the team that contains it and highlight it.
  const search = useSearch();
  const [location, setLocation] = useLocation();
  const appParam = new URLSearchParams(search).get("app");
  const highlightAppId = appParam != null ? Number(appParam) : null;

  // The highlight is a "flash to show you where the row is", not a persistent
  // selection: a few seconds after arriving, strip ?app from the URL (replace,
  // so Back still works) which fades the highlight out and makes sure a
  // refresh doesn't bring back a stale highlight.
  useEffect(() => {
    if (appParam == null) return;
    const timer = setTimeout(() => {
      const params = new URLSearchParams(search);
      params.delete("app");
      const rest = params.toString();
      setLocation(rest ? `${location}?${rest}` : location, { replace: true });
    }, 4000);
    return () => clearTimeout(timer);
  }, [appParam, search, location, setLocation]);
  const highlightTeam =
    highlightAppId != null && Number.isFinite(highlightAppId)
      ? teams.find((t) =>
          t.rows.some((r) => r.applicationId === highlightAppId),
        )
      : undefined;

  // Arriving via ?app counts as "choosing" that team, so remember it too;
  // otherwise the view would jump back to the stored team once the
  // highlight fades.
  useEffect(() => {
    if (highlightTeam != null) setStoredTeamId(highlightTeam.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlightTeam?.id]);

  const validStoredTeamId =
    storedTeamId != null && teams.some((t) => t.id === storedTeamId)
      ? storedTeamId
      : null;
  const teamId =
    selectedTeamId ?? highlightTeam?.id ?? validStoredTeamId ?? teams[0]?.id;
  const team = teams.find((t) => t.id === teamId);
  const effectiveHighlight =
    highlightTeam != null && highlightTeam.id === teamId ? highlightAppId : null;

  // If the chip's application has no matrix row anymore (e.g. an admin deleted
  // it between render and click), tell staff instead of silently showing the
  // first team with no highlight. Dismissal is keyed on the param so a new
  // chip click re-shows the notice.
  const [dismissedNoticeFor, setDismissedNoticeFor] = useState<string | null>(
    null,
  );
  const showMissingRowNotice =
    !isLoading &&
    data != null &&
    appParam != null &&
    Number.isFinite(highlightAppId) &&
    highlightTeam == null &&
    dismissedNoticeFor !== appParam;

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">RACI Matrix</h2>
        <p className="text-sm text-muted-foreground">
          Who is Responsible, Accountable, Consulted, and Informed for each IT
          decision or task.
        </p>
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-14" />
          ))}
        </div>
      ) : teams.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            {/* Empty-state text is asserted by scripts/src/staff-ui-check.ts — keep in sync. */}
            No RACI data yet.
          </CardContent>
        </Card>
      ) : (
        <>
          {showMissingRowNotice && (
            <MissingRowNotice
              onDismiss={() => setDismissedNoticeFor(appParam)}
            />
          )}
          <div className="flex flex-wrap gap-1.5">
            {teams.map((t) => (
              <Button
                key={t.id}
                size="sm"
                variant={t.id === teamId ? "default" : "outline"}
                onClick={() => setSelectedTeamId(t.id)}
              >
                {t.name}
              </Button>
            ))}
          </div>
          {team && (
            <TeamMatrix
              key={team.id}
              team={team}
              highlightAppId={effectiveHighlight}
            />
          )}
        </>
      )}
    </div>
  );
}
