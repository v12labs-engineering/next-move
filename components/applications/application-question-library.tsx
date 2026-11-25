"use client"
import { useEffect, useState } from "react"
import Link from "next/link"
import { AppShell } from "@/components/shell/app-shell"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { ChevronDown } from "lucide-react"
import { cn } from "@/lib/utils"
import {
  type ReuseScope,
  type SavedQuestion,
  validSavedAnswer,
  canReuseQuestion,
} from "@/lib/applications/questions"

const scopeLabels: Record<ReuseScope, string> = {
  never: "Ask again next time",
  employer: "Reuse for this employer",
  all: "Reuse across employers",
}

function QuestionRow({
  question,
  changed,
}: {
  question: SavedQuestion
  changed: () => void
}) {
  const field = question.question
  const initialScope =
    question.answer === null &&
    !question.reuse_explicit &&
    canReuseQuestion(field)
      ? "all"
      : question.reuse_scope
  const [editing, setEditing] = useState(false)
  const [answer, setAnswer] = useState<string | string[]>(question.answer ?? "")
  const [scope, setScope] = useState<ReuseScope>(initialScope)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  async function save(method: "PATCH" | "DELETE") {
    setBusy(true)
    setError("")
    try {
      const response = await fetch(
        `/api/application-questions/${question.id}`,
        {
          method,
          headers: { "Content-Type": "application/json" },
          ...(method === "PATCH"
            ? { body: JSON.stringify({ answer, scope }) }
            : {}),
        }
      )
      const data = await response.json()
      if (!response.ok) throw new Error(data.error)
      setEditing(false)
      changed()
      window.dispatchEvent(new Event("application-questions-changed"))
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Could not save answer."
      )
    } finally {
      setBusy(false)
    }
  }
  const selected = Array.isArray(answer) ? answer : answer ? [answer] : []
  return (
    <li className="grid gap-3 border-b p-4 last:border-b-0 sm:p-5">
      <div>
        <h2
          className={cn(
            "text-sm leading-relaxed font-medium",
            field.label.length > 180 && "line-clamp-2"
          )}
        >
          {field.label}
        </h2>
        {field.label.length > 180 && (
          <details className="group">
            <summary className="inline-flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-lg text-xs text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
              Read full question
              <ChevronDown
                aria-hidden
                className="size-3.5 shrink-0 transition-transform group-open:rotate-180"
              />
            </summary>
            <p className="mt-3 rounded-lg bg-muted/40 p-3 text-[13px] leading-relaxed wrap-break-word">
              {field.label}
            </p>
          </details>
        )}
        <p className="mt-1 text-xs text-muted-foreground">
          {question.company}
          {question.country ? ` · ${question.country}` : ""} ·{" "}
          {question.reuse_scope === "never" && !question.reuse_explicit
            ? "No reuse preference for this employer"
            : scopeLabels[question.reuse_scope]}
        </p>
      </div>
      {field.help && (
        <p className="text-xs text-muted-foreground">{field.help}</p>
      )}
      {editing ? (
        <div className="grid gap-3">
          {field.kind === "checkbox" ? (
            <fieldset aria-label={field.label} className="grid gap-2">
              {field.options.map((option) => (
                <label key={option} className="flex gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={selected.includes(option)}
                    disabled={busy}
                    onChange={(event) =>
                      setAnswer(
                        event.target.checked
                          ? [...selected, option]
                          : selected.filter((v) => v !== option)
                      )
                    }
                  />
                  {option}
                </label>
              ))}
            </fieldset>
          ) : field.options.length ? (
            <Select
              disabled={busy}
              value={
                selected[0]
                  ? `option-${field.options.indexOf(selected[0])}`
                  : ""
              }
              onValueChange={(value) =>
                setAnswer(
                  value === "unanswered"
                    ? ""
                    : field.options[Number(value.slice(7))]
                )
              }
            >
              <SelectTrigger
                aria-label={field.label}
                className="w-full min-w-0"
              >
                <SelectValue placeholder="Choose an answer" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="unanswered">Choose an answer</SelectItem>
                {field.options.map((option, index) =>
                  option ? (
                    <SelectItem key={index} value={`option-${index}`}>
                      {option}
                    </SelectItem>
                  ) : null
                )}
              </SelectContent>
            </Select>
          ) : field.kind === "textarea" || field.kind === "cover_letter" ? (
            <textarea
              aria-label={field.label}
              disabled={busy}
              className="min-h-28 min-w-0 rounded-lg border border-input bg-background p-3 text-base outline-none focus-visible:ring-2 focus-visible:ring-ring/40 sm:text-sm"
              maxLength={5000}
              value={selected[0] || ""}
              onChange={(event) => setAnswer(event.target.value)}
            />
          ) : (
            <Input
              aria-label={field.label}
              disabled={busy}
              maxLength={5000}
              type={field.kind}
              value={selected[0] || ""}
              onChange={(event) => setAnswer(event.target.value)}
            />
          )}
          <label className="grid gap-1 text-xs text-muted-foreground">
            Use this answer
            <Select
              disabled={busy}
              value={scope}
              onValueChange={(value) => setScope(value as ReuseScope)}
            >
              <SelectTrigger
                aria-label="Use this saved answer"
                className="w-full min-w-0 text-foreground"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(scopeLabels)
                  .filter(
                    ([value]) => value === "never" || canReuseQuestion(field)
                  )
                  .map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </label>
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={busy || !validSavedAnswer(field, answer)}
              onClick={() => save("PATCH")}
            >
              Save answer
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => setEditing(false)}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <>
          <p className="text-sm whitespace-pre-line">
            {question.answer === null
              ? "Not answered yet"
              : Array.isArray(question.answer)
                ? question.answer.join(", ")
                : question.answer}
          </p>
          <div className="flex flex-wrap gap-2">
            {field.kind !== "unsupported" && (
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => {
                  setAnswer(question.answer ?? "")
                  setScope(initialScope)
                  setEditing(true)
                }}
              >
                {question.answer === null ? "Add answer" : "Edit answer"}
              </Button>
            )}
            {question.source_application_id && (
              <Button size="sm" variant="ghost" asChild>
                <Link href={`/applications/${question.source_application_id}`}>
                  View application
                </Link>
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => save("DELETE")}
            >
              Forget
            </Button>
          </div>
        </>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </li>
  )
}

export function ApplicationQuestionLibrary() {
  const [questions, setQuestions] = useState<SavedQuestion[]>([])
  const [offset, setOffset] = useState(0),
    [total, setTotal] = useState(0),
    [version, setVersion] = useState(0)
  const [loading, setLoading] = useState(true),
    [error, setError] = useState("")
  useEffect(() => {
    let active = true
    const load = async () => {
      setLoading(true)
      setError("")
      try {
        const response = await fetch(
          `/api/application-questions?offset=${offset}`,
          { cache: "no-store" }
        )
        const data = await response.json()
        if (!response.ok) throw new Error(data.error)
        if (active) {
          setQuestions(data.questions)
          setTotal(data.total)
        }
      } catch (error) {
        if (active)
          setError(
            error instanceof Error
              ? error.message
              : "Could not load saved answers."
          )
      } finally {
        if (active) setLoading(false)
      }
    }
    void load()
    return () => {
      active = false
    }
  }, [offset, version])
  return (
    <AppShell
      title="Saved application answers"
      description="Your saved answers stay private and are reused for matching questions by default. You can edit, limit reuse or forget them here."
      actions={
        <Button variant="outline" asChild>
          <Link href="/applications">Applications</Link>
        </Button>
      }
    >
      <p className="max-w-[70ch] text-sm text-muted-foreground">
        Reuse applies to matching question wording, answer options and
        destination country. Use across employers only for facts that stay the
        same across jobs. Saved answers never replace an answer you already
        entered. You can edit or forget them here. Changes affect future fills;
        existing applications keep their recorded answers.
      </p>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {loading ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading questions…
        </p>
      ) : questions.length ? (
        <ul className="rounded-xl border bg-card">
          {questions.map((question) => (
            <QuestionRow
              key={question.id}
              question={question}
              changed={() => setVersion((v) => v + 1)}
            />
          ))}
        </ul>
      ) : (
        <p className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
          New application questions will appear here. Answer them in your
          application or add an answer here.
        </p>
      )}
      <div className="flex items-center gap-3">
        <Button
          size="sm"
          variant="outline"
          disabled={loading || offset === 0}
          onClick={() => setOffset((v) => Math.max(0, v - 50))}
        >
          Previous
        </Button>
        <span className="text-xs text-muted-foreground">
          {total
            ? `${offset + 1}–${Math.min(offset + 50, total)} of ${total}`
            : "0 questions"}
        </span>
        <Button
          size="sm"
          variant="outline"
          disabled={loading || offset + 50 >= total}
          onClick={() => setOffset((v) => v + 50)}
        >
          Next
        </Button>
      </div>
    </AppShell>
  )
}
