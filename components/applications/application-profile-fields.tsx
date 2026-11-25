"use client"

import {
  applicationCurrencies,
  applicationProfileFromResume,
  type ApplicationProfile,
} from "@/lib/applications/profile"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

const selectClass =
  "min-h-11 w-full min-w-0 rounded-lg border border-input bg-background px-3 py-2 text-base outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50 sm:text-sm"
const numberValue = (value: string) => (value === "" ? null : Number(value))

function Choice({
  id,
  label,
  value,
  onChange,
  disabled,
}: {
  id: string
  label: string
  value: boolean | null
  onChange: (value: boolean | null) => void
  disabled: boolean
}) {
  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>{label}</Label>
      <Select
        disabled={disabled}
        value={value === null ? "unspecified" : String(value)}
        onValueChange={(value) =>
          onChange(value === "unspecified" ? null : value === "true")
        }
      >
        <SelectTrigger id={id} className="w-full min-w-0">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="unspecified">Not specified</SelectItem>
          <SelectItem value="true">Yes</SelectItem>
          <SelectItem value="false">No</SelectItem>
        </SelectContent>
      </Select>
    </div>
  )
}

export function ApplicationProfileFields({
  value,
  resumeText,
  countries,
  disabled,
  onChange,
  onboarding = false,
}: {
  onboarding?: boolean
  value?: ApplicationProfile
  resumeText: string
  countries: string[]
  disabled: boolean
  onChange: (profile: ApplicationProfile) => void
}) {
  const profile = value ?? applicationProfileFromResume(resumeText)
  function update(patch: Partial<ApplicationProfile>) {
    onChange({ ...profile, ...patch, confirmedAt: null })
  }
  return (
    <fieldset disabled={disabled} className="min-w-0 space-y-5">
      <legend className="sr-only">Reusable application profile</legend>
      <div className="flex items-start justify-between gap-4">
        <Label
          htmlFor="use-application-profile"
          className="flex-col items-start gap-1"
        >
          <span>Answer application questions for me</span>
          <span className="text-[13px] font-normal text-muted-foreground">
            Fill forms from these details, your resume and your earlier answers.
            Anything we can&apos;t answer waits for you once, then is reused.
          </span>
        </Label>
        <Switch
          id="use-application-profile"
          checked={profile.enabled}
          onCheckedChange={(enabled) => update({ enabled })}
        />
      </div>
      <details
        open={onboarding || profile.enabled || undefined}
        className="space-y-4"
      >
        <summary className="cursor-pointer text-sm font-medium">
          {onboarding ? "Common application questions" : "Application details"}
        </summary>
        <p className="text-[13px] text-muted-foreground">
          We prefill contacts from your resume. Your employment, education and
          projects come from the resume you reviewed. Leave any other answer
          unspecified until you know it.
        </p>
        <p className="text-[13px] text-muted-foreground">
          Confirm your preferred full name and legal name parts for forms that
          ask for them separately. Include all parts in the correct box; we do
          not guess how to split names with more than two words. Ordinary
          full-name fields use the name on your reviewed profile.
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          {(
            [
              ["preferredName", "Preferred full name", "text"],
              ["givenName", "Legal first / given name(s)", "text"],
              ["familyName", "Legal last / family name", "text"],
              ["location", "Current city and country", "text"],
              ["email", "Application email", "email"],
              ["phone", "Phone with country code", "tel"],
              ["linkedin", "LinkedIn URL", "url"],
              ["github", "GitHub URL", "url"],
              ["portfolio", "Portfolio URL", "url"],
            ] as const
          ).map(([key, label, type]) => (
            <div key={key} className="grid gap-2">
              <Label htmlFor={`application-${key}`}>{label}</Label>
              <Input
                id={`application-${key}`}
                type={type}
                value={profile.contact[key]}
                onChange={(event) =>
                  update({
                    contact: { ...profile.contact, [key]: event.target.value },
                  })
                }
                maxLength={
                  key === "phone"
                    ? 50
                    : key === "givenName" ||
                        key === "location" ||
                        key === "familyName" ||
                        key === "preferredName"
                      ? 120
                      : 500
                }
              />
            </div>
          ))}
        </div>
        <h3 className="text-sm font-medium">
          Availability, relocation and travel
        </h3>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="grid gap-2">
            <Label htmlFor="application-notice">
              Notice period in calendar days
            </Label>
            <Input
              id="application-notice"
              type="number"
              min={0}
              max={365}
              value={profile.noticeDays ?? ""}
              placeholder="Unspecified"
              onChange={(event) =>
                update({ noticeDays: numberValue(event.target.value) })
              }
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="application-start">
              Earliest start date (optional)
            </Label>
            <Input
              id="application-start"
              type="date"
              value={profile.earliestStart ?? ""}
              onChange={(event) =>
                update({ earliestStart: event.target.value || null })
              }
            />
          </div>
          <Choice
            disabled={disabled}
            id="application-relocation"
            label="Willing to relocate?"
            value={profile.willingToRelocate}
            onChange={(willingToRelocate) => update({ willingToRelocate })}
          />
          <Choice
            disabled={disabled}
            id="application-travel"
            label="Willing to travel for work?"
            value={profile.willingToTravel}
            onChange={(willingToTravel) => update({ willingToTravel })}
          />
        </div>
        <p className="text-[13px] text-muted-foreground">
          When both are provided, we use the later of your notice period and
          earliest start date. We ask again when a question adds conditions,
          such as a travel percentage.
        </p>
        <div className="space-y-1">
          <h3 className="text-sm font-medium">Work authorization and salary</h3>
          <p className="text-[13px] text-muted-foreground">
            Tell us whether you can work in India and whether you need
            sponsorship now or in the future.
          </p>
        </div>
        {countries.map((country, index) => {
          const eligibility = profile.eligibility.find(
            (entry) => entry.country === country
          ) ?? {
            country,
            authorized: null,
            sponsorshipNow: null,
            sponsorshipFuture: null,
          }
          const pay = profile.compensation.find(
            (entry) => entry.country === country
          ) ?? {
            country,
            minimum: null,
            maximum: null,
            singleAmount: null,
            currency: "",
            period: "year" as const,
            basis: "base" as const,
          }
          function updateEligibility(patch: Partial<typeof eligibility>) {
            update({
              eligibility: [
                ...profile.eligibility.filter(
                  (entry) => entry.country !== country
                ),
                { ...eligibility, ...patch },
              ],
            })
          }
          function updatePay(patch: Partial<typeof pay>) {
            update({
              compensation: [
                ...profile.compensation.filter(
                  (entry) => entry.country !== country
                ),
                { ...pay, ...patch },
              ],
            })
          }
          return (
            <fieldset key={country} className="space-y-4 rounded-xl border p-4">
              <legend className="px-1 text-sm font-medium">{country}</legend>
              <div className="grid gap-4">
                <Choice
                  disabled={disabled}
                  id={`application-authorized-${index}`}
                  label={`Currently authorized to work in ${country}?`}
                  value={eligibility.authorized}
                  onChange={(authorized) => updateEligibility({ authorized })}
                />
                <div className="grid gap-4 sm:grid-cols-2">
                  <Choice
                    disabled={disabled}
                    id={`application-sponsor-now-${index}`}
                    label="Need sponsorship now?"
                    value={eligibility.sponsorshipNow}
                    onChange={(sponsorshipNow) =>
                      updateEligibility({ sponsorshipNow })
                    }
                  />
                  <Choice
                    disabled={disabled}
                    id={`application-sponsor-future-${index}`}
                    label="Need sponsorship in the future?"
                    value={eligibility.sponsorshipFuture}
                    onChange={(sponsorshipFuture) =>
                      updateEligibility({ sponsorshipFuture })
                    }
                  />
                </div>
              </div>
              <details open={onboarding || undefined} className="space-y-4">
                <summary className="cursor-pointer text-sm font-medium">
                  Salary expectations (optional)
                </summary>
                <div className="grid gap-4 sm:grid-cols-2">
                  {(
                    [
                      ["minimum", "Expected range: minimum"],
                      ["maximum", "Expected range: maximum"],
                      ["singleAmount", "Amount for single-number questions"],
                    ] as const
                  ).map(([key, label]) => (
                    <div key={key} className="grid gap-2">
                      <Label htmlFor={`application-pay-${index}-${key}`}>
                        {label}
                      </Label>
                      <Input
                        id={`application-pay-${index}-${key}`}
                        type="number"
                        min={1}
                        max={1000000000}
                        step="any"
                        value={pay[key] ?? ""}
                        onChange={(event) =>
                          updatePay({ [key]: numberValue(event.target.value) })
                        }
                      />
                    </div>
                  ))}
                  <div className="grid gap-2">
                    <Label htmlFor={`application-currency-${index}`}>
                      Currency
                    </Label>
                    <Select
                      disabled={disabled}
                      value={pay.currency || "unspecified"}
                      onValueChange={(value) =>
                        updatePay({
                          currency:
                            value === "unspecified"
                              ? ""
                              : (value as typeof pay.currency),
                        })
                      }
                    >
                      <SelectTrigger
                        id={`application-currency-${index}`}
                        className="w-full min-w-0"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="unspecified">
                          Choose currency
                        </SelectItem>
                        {applicationCurrencies.map((currency) => (
                          <SelectItem key={currency} value={currency}>
                            {currency}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor={`application-period-${index}`}>
                      Pay period
                    </Label>
                    <Select
                      disabled={disabled}
                      value={pay.period}
                      onValueChange={(value) =>
                        updatePay({
                          period: value as typeof pay.period,
                        })
                      }
                    >
                      <SelectTrigger
                        id={`application-period-${index}`}
                        className="w-full min-w-0"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="year">Annual</SelectItem>
                        <SelectItem value="month">Monthly</SelectItem>
                        <SelectItem value="hour">Hourly</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor={`application-basis-${index}`}>
                      Compensation basis
                    </Label>
                    <Select
                      disabled={disabled}
                      value={pay.basis}
                      onValueChange={(value) =>
                        updatePay({
                          basis: value as typeof pay.basis,
                        })
                      }
                    >
                      <SelectTrigger
                        id={`application-basis-${index}`}
                        className="w-full min-w-0"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="base">Base salary</SelectItem>
                        <SelectItem value="total">
                          Total compensation
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <p className="text-[13px] text-muted-foreground">
                  We use your range for text answers. A numeric answer needs
                  matching currency, period and compensation basis. We never
                  convert or choose an amount for you.
                </p>
              </details>
            </fieldset>
          )
        })}
        <div className="grid gap-2">
          <Label htmlFor="application-interests">
            What do you want from your next role? (used for &quot;why this
            company&quot; answers)
          </Label>
          <textarea
            id="application-interests"
            className={`${selectClass} min-h-24`}
            maxLength={1500}
            placeholder="The work, problems or responsibilities that interest you."
            value={profile.careerInterests}
            onChange={(event) =>
              update({ careerInterests: event.target.value })
            }
          />
        </div>
      </details>
      {profile.enabled && (
        <p className="text-[13px] text-muted-foreground">
          Saving confirms these details are current and may be used in your
          applications. Turn the switch off to stop.
        </p>
      )}
    </fieldset>
  )
}
