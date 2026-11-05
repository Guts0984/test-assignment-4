import type { ComponentProps } from "react";
import { cn } from "@/shared/lib/utils";
import { Input } from "./input";
import { Label } from "./label";

export interface TextFieldProps extends Omit<ComponentProps<typeof Input>, "id"> {
  id: string;
  label: string;
  /** Messages for this field, shown under it and tied to it for screen readers. */
  errors?: readonly string[] | undefined;
  hint?: string | undefined;
}

/** A labelled input. Its errors and hint are announced with it (aria-describedby) and it is marked invalid. */
export function TextField({ id, label, errors, hint, className, ...input }: TextFieldProps) {
  const hasErrors = Boolean(errors && errors.length > 0);
  const describedBy = [hasErrors ? `${id}-error` : undefined, hint ? `${id}-hint` : undefined].filter(Boolean).join(" ") || undefined;
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} aria-invalid={hasErrors || undefined} aria-describedby={describedBy} className={cn(className)} {...input} />
      {hint && (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
      {hasErrors && (
        <p id={`${id}-error`} role="alert" className="text-sm text-destructive">
          {errors?.join(" ")}
        </p>
      )}
    </div>
  );
}
