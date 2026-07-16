/**
 * Regression test: toasts dispatched before <Toaster> mounts must still render.
 *
 * A toast fired during the app's very first render (e.g. from a mount effect
 * that runs before the Toaster's subscription effect) used to be silently
 * dropped because the dispatch hit an empty listeners array and the Toaster
 * kept its initial empty snapshot. useToast now syncs from memoryState on
 * subscribe. See .agents/memory/toast-before-toaster-mount.md.
 */
import * as React from "react";
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import { toast, useToast } from "@/hooks/use-toast";
import { Toaster } from "@/components/ui/toaster";

afterEach(() => {
  cleanup();
});

describe("use-toast early-mount regression", () => {
  it("renders a toast dispatched before <Toaster> mounts", () => {
    // Dispatch while no component is subscribed — this is the exact scenario
    // that used to lose the toast.
    act(() => {
      toast({ title: "Sign-in failed", description: "Try again" });
    });

    render(<Toaster />);

    expect(screen.getAllByText("Sign-in failed").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Try again").length).toBeGreaterThan(0);
  });

  it("renders a toast fired from a sibling's mount effect that runs before Toaster subscribes", () => {
    function FiresOnMount() {
      React.useEffect(() => {
        toast({ title: "Nightly sync failed" });
      }, []);
      return null;
    }

    // FiresOnMount renders first, so its effect runs before Toaster's
    // subscription effect in the same commit.
    render(
      <>
        <FiresOnMount />
        <Toaster />
      </>,
    );

    expect(screen.getAllByText("Nightly sync failed").length).toBeGreaterThan(0);
  });

  it("still receives toasts dispatched after mount", () => {
    render(<Toaster />);

    act(() => {
      toast({ title: "Saved" });
    });

    expect(screen.getAllByText("Saved").length).toBeGreaterThan(0);
  });
});
