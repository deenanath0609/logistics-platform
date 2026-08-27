import { Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MAX_LOOKUP } from "@/lib/portal/tracking";

/**
 * The lookup box.
 *
 * A plain GET form on purpose: the result lands on a real URL, which is
 * what makes a tracking link shareable and what lets someone bookmark the
 * three consignments they check every morning. No client JavaScript is
 * needed for any of it.
 */
export function TrackForm({ defaultValue = "" }: { defaultValue?: string }) {
  return (
    <form
      method="get"
      action="/track"
      className="flex flex-col gap-2"
      role="search"
    >
      <Label htmlFor="lr">Consignment number</Label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          id="lr"
          name="lr"
          defaultValue={defaultValue}
          placeholder="LR number or your own reference"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          className="font-mono sm:flex-1"
          required
        />
        <Button type="submit" size="lg">
          <Search />
          Track
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Checking several at once? Separate them with commas — up to{" "}
        {MAX_LOOKUP} at a time.
      </p>
    </form>
  );
}
