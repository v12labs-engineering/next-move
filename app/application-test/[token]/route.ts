import { testHtml, testReceipt } from "@/lib/server/applications/test-employer"
import { supabaseServerClient } from "@/lib/server/supabase-server"
export async function GET(
  _r: Request,
  c: { params: Promise<{ token: string }> }
) {
  const { token } = await c.params
  const receipt = await testReceipt(token)
  if (!receipt) return new Response("Not found", { status: 404 })
  if (
    receipt.submissions &&
    new URL(_r.url).searchParams.get("challenge") === "1"
  )
    return testHtml(
      "<p>Generated manual verification fixture. This is not a CAPTCHA.</p>"
    )
  if (receipt.submissions)
    return testHtml(
      "<h1>Application submitted</h1><p>This synthetic test has already been received. No employer was contacted.</p>"
    )
  const run = await supabaseServerClient()
    .from("application_runs")
    .select("employer_key,status")
    .eq("id", receipt.application_id)
    .single()
  if (run.error) throw run.error
  const fieldHelp = run.data.employer_key === "synthetic-field-assistance"
  const temporalNames = run.data.employer_key === "synthetic-temporal-names"
  const nameFields = temporalNames
    ? '<div><label for="_systemfield_name">Preferred First &amp; Last Name</label><label for="_systemfield_name">Preferred First &amp; Last Name</label><input id="_systemfield_name" name="name" autocomplete="off" required></div><div><label for="legal-first-name">Legal First Name</label><label for="legal-first-name">Legal First Name</label><input id="legal-first-name" name="legalGivenName" autocomplete="off" required></div><div><label for="legal-last-name">Legal Last Name</label><label for="legal-last-name">Legal Last Name</label><input id="legal-last-name" name="legalFamilyName" autocomplete="off" required></div><div><label for="pronouns">Preferred Pronouns</label><input id="pronouns" name="pronouns" autocomplete="off"></div><div><label for="pronunciation">Name Pronunciation</label><input id="pronunciation" name="pronunciation" autocomplete="off"></div><div><label for="linkedin">LinkedIn Profile</label><label for="linkedin">LinkedIn Profile</label><input id="linkedin" name="linkedin" autocomplete="off" required></div>'
    : '<div><label for="_systemfield_name">Full name</label><input id="_systemfield_name" name="name" required></div>'
  const needsHelp = fieldHelp && run.data.status === "running"
  return testHtml(
    `<h1>Synthetic staging employer</h1><p>This is a test form. No real employer receives this application and no email is sent.</p><aside>This job has application limits. Candidates may not apply more than 5 times in any 60 days. This informational notice does not indicate a rejection.</aside><div><form action="/api/application-test/${token}" method="post" enctype="multipart/form-data">
 ${nameFields}
 <div><label for="_systemfield_email">Email</label><input id="_systemfield_email" name="email" type="email" required></div>
 <div><label for="_systemfield_resume">Resume</label><input id="_systemfield_resume" name="resume" type="file" required accept=".pdf,.docx"></div>
 <fieldset><label for="authorization" data-required="true">Do you have the required work authorization?</label><div><input type="radio" id="authorization-yes" name="authorization" value="Yes" required><label for="authorization-yes">Yes</label></div><div><input type="radio" id="authorization-no" name="authorization" value="No" required><label for="authorization-no">No</label></div></fieldset>
 <div><label for="referral">Who is your employee referral contact?</label><input id="referral" name="referral" required></div>
 <fieldset><label for="consent">Optional future contact</label><input type="checkbox" id="future-contact" name="futureContact" value="I agree"><label for="future-contact">I agree</label></fieldset>
 ${fieldHelp ? `<label for="location">Location</label><input id="location" name="location" role="combobox" aria-required="true" aria-controls="cities" required autocomplete="off"><input name="locationCode" id="locationCode" type="hidden"><div id="cities" role="listbox" hidden><button type="button" role="option" onclick="locationInput.value='Example City, Region, Country';locationCode.value='city-qa';cities.hidden=true">Example City, Region, Country</button></div>${needsHelp ? `<p>A generated manual step is needed to enable location choices. This is not a CAPTCHA.</p><button type="button" id="enable-location" onclick="window.choicesEnabled=true;this.hidden=true">Enable location choices</button>` : ""}<script>const locationInput=document.getElementById('location');window.choicesEnabled=${!needsHelp};locationInput.addEventListener('input',()=>{locationCode.value='';if(window.choicesEnabled)setTimeout(()=>{cities.hidden=false},900)});locationInput.addEventListener('blur',()=>{if(!locationCode.value)locationInput.value=''});</script>` : ""}
 <p>Test privacy notice: submitted fields are checked against the approved snapshot. Only receipt time and a one-submission counter are stored by this fixture.</p><button type="submit">Submit application</button></form></div>`,
    200,
    false,
    fieldHelp
  )
}
