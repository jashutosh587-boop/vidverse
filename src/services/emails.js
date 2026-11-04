/** Plain-text email bodies. Links carry single-use tokens; nothing else secret is ever put in an email. */
export function verifyEmail({ siteName, baseUrl, token, displayName }) {
  return {
    subject: `Confirm your email address for ${siteName}`,
    text: `Hi ${displayName},

Confirm your email address to finish setting up your ${siteName} account:

${baseUrl}/verify-email?token=${token}

The link works once and expires in 24 hours. If you did not create this account, ignore this message and nothing will happen.
`,
  };
}

export function alreadyRegisteredEmail({ siteName, baseUrl }) {
  return {
    subject: `Someone tried to create a ${siteName} account with your address`,
    text: `Someone just tried to sign up for ${siteName} with this email address, but you already have an account.

If it was you, sign in here, or reset your password if you have forgotten it:

${baseUrl}/login
${baseUrl}/forgot-password

If it was not you, you can ignore this message. Your account is unchanged.
`,
  };
}

export function resetEmail({ siteName, baseUrl, token }) {
  return {
    subject: `Reset your ${siteName} password`,
    text: `We received a request to reset the password for your ${siteName} account.

Choose a new password here:

${baseUrl}/reset-password?token=${token}

The link works once and expires in one hour. When you set a new password, every device is signed out. If you did not ask for this, ignore this message; your password has not changed.
`,
  };
}

export function passwordChangedEmail({ siteName, baseUrl }) {
  return {
    subject: `Your ${siteName} password was changed`,
    text: `The password for your ${siteName} account was just changed, and every device was signed out.

If this was you, there is nothing to do. If it was not, reset your password now and contact us:

${baseUrl}/forgot-password
`,
  };
}

export function payoutDetailsChangedEmail({ siteName, baseUrl, hint }) {
  return {
    subject: `Your payout details on ${siteName} were changed`,
    text: `The payout details on your ${siteName} account were just changed to: ${hint}

For your safety, new payout requests are paused for 24 hours after a change.

If this was you, there is nothing to do. If it was not, sign in, change your password and turn on two-step verification, and write to us straight away:

${baseUrl}/contact
`,
  };
}
