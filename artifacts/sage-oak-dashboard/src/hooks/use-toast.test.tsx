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
import { toast, useToast, resetToastStateForTests } from "@/hooks/use-toast";
import { Toaster } from "@/components/ui/toaster";

afterEach(() => {
  act(() => {
    resetToastStateForTests();
  });
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

describe("error toast priority", () => {
  it("stacks an informational toast alongside an error toast instead of replacing it", () => {
    render(<Toaster />);

    act(() => {
      toast({ title: "Sign-in failed", variant: "destructive" });
    });
    act(() => {
      toast({ title: "Settings saved" });
    });

    expect(screen.getAllByText("Sign-in failed").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Settings saved").length).toBeGreaterThan(0);
  });

  it("keeps an error toast visible even when the stack overflows with newer informational toasts", () => {
    render(<Toaster />);

    act(() => {
      toast({ title: "Nightly sync failed", variant: "destructive" });
    });
    act(() => {
      toast({ title: "Info 1" });
    });
    act(() => {
      toast({ title: "Info 2" });
    });
    act(() => {
      toast({ title: "Info 3" });
    });

    // The error survives; the oldest informational toast is the one evicted.
    expect(screen.getAllByText("Nightly sync failed").length).toBeGreaterThan(0);
    expect(screen.queryByText("Info 1")).toBeNull();
    expect(screen.getAllByText("Info 2").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Info 3").length).toBeGreaterThan(0);
  });

  it("evicts the oldest error when the stack is full of errors and a new error arrives", () => {
    render(<Toaster />);

    act(() => {
      toast({ title: "Error A", variant: "destructive" });
    });
    act(() => {
      toast({ title: "Error B", variant: "destructive" });
    });
    act(() => {
      toast({ title: "Error C", variant: "destructive" });
    });
    act(() => {
      toast({ title: "Error D", variant: "destructive" });
    });

    expect(screen.queryByText("Error A")).toBeNull();
    expect(screen.getAllByText("Error B").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Error C").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Error D").length).toBeGreaterThan(0);
  });

  it("does not let a new informational toast displace errors when the stack is full of errors", () => {
    render(<Toaster />);

    act(() => {
      toast({ title: "Error A", variant: "destructive" });
    });
    act(() => {
      toast({ title: "Error B", variant: "destructive" });
    });
    act(() => {
      toast({ title: "Error C", variant: "destructive" });
    });
    act(() => {
      toast({ title: "Just an update" });
    });

    expect(screen.getAllByText("Error A").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Error B").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Error C").length).toBeGreaterThan(0);
    expect(screen.queryByText("Just an update")).toBeNull();
  });
});
