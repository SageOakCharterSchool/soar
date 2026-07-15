import { useCallback, useState } from "react";
import {
  useUploadUsageData,
  useGetImportLog,
  type ImportResult,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { UploadCloud, FileText, X, AlertTriangle, CheckCircle2 } from "lucide-react";

interface PendingFile {
  name: string;
  content: string;
}

export default function Upload() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const upload = useUploadUsageData();
  const { data: importLog } = useGetImportLog();

  const addFiles = useCallback(async (list: FileList | File[]) => {
    const incoming = await Promise.all(
      Array.from(list)
        .filter((f) => f.name.toLowerCase().endsWith(".csv"))
        .map(async (f) => ({ name: f.name, content: await f.text() })),
    );
    setFiles((prev) => {
      const names = new Set(incoming.map((f) => f.name));
      return [...prev.filter((f) => !names.has(f.name)), ...incoming];
    });
  }, []);

  const hasExportProps = files.some(
    (f) => f.name.toLowerCase() === "exportproperties.csv",
  );

  const submit = () =>
    upload.mutate(
      { data: { files } },
      {
        onSuccess: (res) => {
          setResult(res);
          setFiles([]);
          queryClient.invalidateQueries({
            predicate: (q) =>
              String(q.queryKey[0]).includes("usage") ||
              String(q.queryKey[0]).includes("uploads") ||
              String(q.queryKey[0]).includes("rostering"),
          });
          toast({ title: "Import complete", description: `${res.rowsInserted} rows inserted, ${res.rowsUpdated} updated.` });
        },
        onError: (err: any) =>
          toast({ title: "Import failed", description: err?.data?.message ?? "Check the files and try again.", variant: "destructive" }),
      },
    );

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">Upload Data</h2>
        <p className="text-muted-foreground text-sm mt-1">
          Upload the monthly "last 28 days" CSV exports from Clever (12 files).
          History accumulates — previously imported dates are never deleted, and
          re-uploaded dates are corrected in place.
        </p>
      </div>

      <div
        className={`border-2 border-dashed rounded-xl p-10 text-center transition-colors ${
          dragOver ? "border-primary bg-primary/5" : "border-border"
        }`}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          void addFiles(e.dataTransfer.files);
        }}
      >
        <UploadCloud className="h-8 w-8 mx-auto text-muted-foreground mb-3" />
        <p className="font-medium">Drag and drop CSV files here</p>
        <p className="text-sm text-muted-foreground mb-4">
          <span className="font-medium">ExportProperties.csv is required</span> — it provides the export date that keys the snapshot.
        </p>
        <Button variant="outline" asChild>
          <label className="cursor-pointer">
            Browse files
            <input
              type="file"
              accept=".csv"
              multiple
              className="hidden"
              onChange={(e) => e.target.files && void addFiles(e.target.files)}
            />
          </label>
        </Button>
      </div>

      {files.length > 0 && (
        <Card>
          <CardHeader className="pb-2 flex flex-row items-center justify-between space-y-0">
            <CardTitle className="text-base">{files.length} file{files.length === 1 ? "" : "s"} ready</CardTitle>
            <Button onClick={submit} disabled={upload.isPending || !hasExportProps}>
              {upload.isPending ? "Importing..." : "Import"}
            </Button>
          </CardHeader>
          <CardContent className="space-y-1">
            {!hasExportProps && (
              <p className="text-sm text-destructive flex items-center gap-1.5 mb-2">
                <AlertTriangle className="h-4 w-4" /> ExportProperties.csv is missing from this batch.
              </p>
            )}
            {files.map((f) => (
              <div key={f.name} className="flex items-center justify-between text-sm py-1">
                <span className="flex items-center gap-2">
                  <FileText className="h-4 w-4 text-muted-foreground" /> {f.name}
                </span>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-6 w-6"
                  aria-label={`Remove ${f.name}`}
                  onClick={() => setFiles((prev) => prev.filter((x) => x.name !== f.name))}
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {result && (
        <Card className="border-emerald-200 dark:border-emerald-900">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-emerald-600" />
              Import result — snapshot {result.snapshotDate}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p>
              <span className="font-medium tabular-nums">{result.rowsInserted}</span> rows inserted,{" "}
              <span className="font-medium tabular-nums">{result.rowsUpdated}</span> rows updated,{" "}
              {result.filesProcessed.length} files processed.
            </p>
            {result.warnings.length > 0 && (
              <ul className="space-y-1">
                {result.warnings.map((w, i) => (
                  <li key={i} className="flex items-start gap-1.5 text-amber-700 dark:text-amber-400">
                    <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" /> {w}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Import history</CardTitle>
        </CardHeader>
        <CardContent className="p-0 overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Uploaded</TableHead>
                <TableHead>By</TableHead>
                <TableHead>Snapshot date</TableHead>
                <TableHead>Files</TableHead>
                <TableHead className="text-right">Inserted</TableHead>
                <TableHead className="text-right">Updated</TableHead>
                <TableHead className="text-right">Warnings</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(importLog ?? []).map((entry) => (
                <TableRow key={entry.id}>
                  <TableCell className="whitespace-nowrap text-sm">
                    {new Date(entry.uploadedAt).toLocaleString()}
                  </TableCell>
                  <TableCell className="text-sm">{entry.uploadedByName}</TableCell>
                  <TableCell className="text-sm">{entry.snapshotDate}</TableCell>
                  <TableCell><Badge variant="secondary">{entry.filesIncluded.length} files</Badge></TableCell>
                  <TableCell className="text-right tabular-nums">{entry.rowsInserted}</TableCell>
                  <TableCell className="text-right tabular-nums">{entry.rowsUpdated}</TableCell>
                  <TableCell className="text-right tabular-nums">{(entry as any).warnings?.length ?? 0}</TableCell>
                </TableRow>
              ))}
              {(!importLog || importLog.length === 0) && (
                <TableRow>
                  <TableCell colSpan={7} className="text-center text-muted-foreground py-8">
                    No imports yet.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
