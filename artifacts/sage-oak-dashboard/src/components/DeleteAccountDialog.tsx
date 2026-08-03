import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useDeleteOwnAccount,
  getGetCurrentUserQueryKey,
} from "@workspace/api-client-react";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogCancel,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";

const CONFIRM_PHRASE = "DELETE";

export function DeleteAccountDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [confirmText, setConfirmText] = useState("");
  const deleteAccount = useDeleteOwnAccount();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const close = (next: boolean) => {
    if (!next) setConfirmText("");
    onOpenChange(next);
  };

  const confirm = () => {
    deleteAccount.mutate(undefined as never, {
      onSuccess: () => {
        toast({
          title: "Account deleted",
          description: "Your account has been permanently deleted.",
        });
        // The session is already gone server-side. Null out the cached user
        // synchronously so the app falls back to the login screen, then drop
        // all cached data. (Any refetch of /auth/me now gets a 401, which
        // keeps the user signed out.)
        queryClient.setQueryData(getGetCurrentUserQueryKey(), null);
        queryClient.clear();
      },
      onError: (err: unknown) => {
        const message =
          (err as { data?: { message?: string } })?.data?.message ??
          "Could not delete your account. Try again.";
        toast({ title: "Delete failed", description: message, variant: "destructive" });
      },
    });
  };

  return (
    <AlertDialog open={open} onOpenChange={close}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete my account?</AlertDialogTitle>
          <AlertDialogDescription>
            This permanently deletes your account, along with issues and requests
            you submitted, and signs you out. This cannot be undone. Type{" "}
            <span className="font-semibold">{CONFIRM_PHRASE}</span> to confirm.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <Input
          value={confirmText}
          onChange={(e) => setConfirmText(e.target.value)}
          placeholder={CONFIRM_PHRASE}
          autoFocus
          data-testid="input-delete-account-confirm"
        />
        <AlertDialogFooter>
          <AlertDialogCancel data-testid="button-cancel-delete-account">
            Cancel
          </AlertDialogCancel>
          <Button
            variant="destructive"
            disabled={confirmText !== CONFIRM_PHRASE || deleteAccount.isPending}
            onClick={confirm}
            data-testid="button-confirm-delete-account"
          >
            {deleteAccount.isPending ? "Deleting…" : "Delete my account"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
