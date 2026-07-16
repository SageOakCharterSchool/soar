import { useMemo, useState } from "react";
import { useLocation } from "wouter";
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
  type RaciTeamData,
  type RaciRow,
  type RaciMember,
  type RaciValue,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useActivityEventRefresh } from "@/hooks/useActivityEventRefresh";
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
  Pencil,
  Plus,
  Trash2,
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

// Click-to-cycle order for admin editing.
const CYCLE: (RaciValue | null)[] = [null, "R", "A", "C", "I", "N/A"];

function Chip({ value }: { value: string | null }) {
  if (!value) return <span className="text-muted-foreground/40">·</span>;
  const meta = VALUE_META[value];
  return (
    <span
      className={`inline-flex h-6 min-w-8 items-center justify-center rounded px-1.5 text-xs font-semibold ${meta?.className ?? "bg-muted"}`}
    >
      {value}
    </span>
  );
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

function TeamMatrix({ team }: { team: RaciTeamData }) {
  const { isAdmin } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [, setLocation] = useLocation();
  const [search, setSearch] = useState("");

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
      toast({
        title: "Changed by another admin",
        description: currentName
          ? `This was just renamed by someone else. It is now called "${currentName}". The matrix has been refreshed — try again if you still want to change it.`
          : "This was just renamed by someone else. The matrix has been refreshed — try again if you still want to change it.",
      });
      invalidate();
      close();
      return;
    }
    onError(err);
  };

  const [editRow, setEditRow] = useState<RaciRow | null>(null);
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
    const next = CYCLE[(CYCLE.indexOf(current) + 1) % CYCLE.length] ?? null;
    setCell.mutate(
      // expectedValue lets the server reject the update if another admin
      // changed this cell since we loaded it (409), instead of overwriting.
      { data: { rowId: row.id, memberId, value: next, expectedValue: current } },
      {
        onSuccess: invalidate,
        onError: (err: any) => {
          if (err?.status === 409) {
            toast({
              title: "Cell changed by another admin",
              description:
                "This cell was just updated by someone else. The matrix has been refreshed — click again to change it.",
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
          {Object.entries(VALUE_META).map(([v, meta]) => (
            <span key={v} className="inline-flex items-center gap-1">
              <Chip value={v} />
              <span className="text-muted-foreground">{meta.label}</span>
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
                                { id: m.id },
                                { onSuccess: invalidate, onError },
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
                    {search
                      ? "No tasks match your search."
                      : "No tasks yet for this team."}
                  </TableCell>
                </TableRow>
              )}
              {groups.map((group, gi) => (
                <GroupRows
                  key={`${group.category ?? "none"}-${gi}`}
                  group={group}
                  team={team}
                  isAdmin={isAdmin}
                  onCycle={cycleCell}
                  onEditRow={setEditRow}
                  onDeleteRow={(row) => {
                    if (window.confirm(`Remove "${row.name}" from the matrix?`)) {
                      deleteRow.mutate({ id: row.id }, { onSuccess: invalidate, onError });
                    }
                  }}
                  onRenameCategory={setEditCategory}
                  onAddRow={(category) => setAddRowCategory(category)}
                  onOpenApp={() => setLocation("/rostering")}
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
      <NamePrompt
        title={`Add member to ${team.name}`}
        label="Member name"
        initial=""
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
  onCycle,
  onEditRow,
  onDeleteRow,
  onRenameCategory,
  onAddRow,
  onOpenApp,
}: {
  group: { category: string | null; rows: RaciRow[] };
  team: RaciTeamData;
  isAdmin: boolean;
  onCycle: (row: RaciRow, memberId: number) => void;
  onEditRow: (row: RaciRow) => void;
  onDeleteRow: (row: RaciRow) => void;
  onRenameCategory: (category: string) => void;
  onAddRow: (category: string | null) => void;
  onOpenApp: () => void;
}) {
  const colSpan = team.members.length + (isAdmin ? 2 : 1);
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
        return (
          <TableRow key={row.id}>
            <TableCell>
              <div className="flex items-center gap-1.5">
                <span className="font-medium">{row.name}</span>
                {row.applicationId != null && (
                  <button
                    className="inline-flex items-center gap-0.5 text-xs text-sky-700 hover:underline dark:text-sky-400"
                    onClick={onOpenApp}
                    title={`Open ${row.appName ?? row.name} on the Rostering board`}
                  >
                    <ExternalLink className="h-3 w-3" />
                    Rostering
                  </button>
                )}
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
                      <Chip value={value} />
                    </button>
                  ) : (
                    <Chip value={value} />
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

export default function Raci() {
  const { data, isLoading } = useGetRaciMatrix();
  // Live-update the matrix when another admin edits it (RACI changes are
  // emitted on the shared rostering activity stream).
  useActivityEventRefresh(getGetRaciMatrixQueryKey());
  const teams = data?.teams ?? [];
  const [selectedTeamId, setSelectedTeamId] = useState<number | null>(null);
  const teamId = selectedTeamId ?? teams[0]?.id;
  const team = teams.find((t) => t.id === teamId);

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
          {team && <TeamMatrix key={team.id} team={team} />}
        </>
      )}
    </div>
  );
}
