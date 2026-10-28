/**
 * Sample documents for the trial page, so the round trip can be tried without
 * reaching for real personal data. Every value in them is invented.
 */

export interface Sample {
  /** Stable, url-safe identifier. */
  readonly id: string;
  /** Button text: two or three words. */
  readonly label: string;
  /** One short line on what the sample exercises. */
  readonly blurb: string;
  /**
   * Names the trial should treat as personal for this sample, as an operator
   * would list them under `redaction.dictionary.names`.
   */
  readonly names: readonly string[];
  readonly text: string;
}

export const SAMPLES: readonly Sample[] = [
  {
    id: 'rechnung',
    label: 'Rechnung',
    blurb: 'German invoice: IBAN, VAT and tax numbers, contacts, a register entry.',
    names: ['Katrin Vogelsang', 'Matthias Brandt', 'Brandt'],
    text: [
      'Nordwerk GmbH',
      'Kaiserstr. 12, 76133 Karlsruhe',
      'Tel. 0721 1234567 · buchhaltung@nordwerk-gmbh.de',
      'Amtsgericht Mannheim, HRB 123456',
      'USt-IdNr. DE811907980 · Steuernummer 27/123/45678',
      '',
      'Hafenstahl Maschinenbau AG',
      'z. Hd. Herrn Matthias Brandt',
      'Hafenstr. 8, 68159 Mannheim',
      '',
      'Rechnung Nr. 2026-0417 vom 14.10.2026',
      '',
      'Betreff: Wartung der Abfüllanlage, Kundennummer 40817',
      '',
      'Sehr geehrter Herr Brandt,',
      '',
      'für die Wartung vom 06.10.2026 berechnen wir 4.280,00 EUR netto zuzüglich 19 % Umsatzsteuer. Bitte überweisen Sie den Betrag von 5.093,20 EUR bis zum 28.10.2026 auf das Konto',
      '',
      'IBAN DE89 3704 0044 0532 0130 00',
      'BIC COBADEFFXXX',
      '',
      'Bei Rückfragen erreichen Sie mich unter katrin.vogelsang@nordwerk-gmbh.de oder 0721 1234568.',
      '',
      'Mit freundlichen Grüßen',
      'Katrin Vogelsang',
      'Buchhaltung, Nordwerk GmbH',
    ].join('\n'),
  },
  {
    id: 'arztbrief',
    label: 'Arztbrief',
    blurb: 'German doctor\'s letter: health data, insurance and tax IDs, medication.',
    names: ['Sabine Hartmann', 'Hartmann', 'Dr. Jonas Weidner', 'Weidner', 'Lena Kowalski'],
    text: [
      'Praxis Dr. Weidner · Allgemeinmedizin',
      'Lange Straße 5, 12345 Musterstadt',
      'Tel. 030 12345678',
      '',
      'Arztbrief vom 21.10.2026',
      '',
      'Patientin: Sabine Hartmann, geboren am 03.07.1984',
      'Versichertennummer: X110403565',
      'Steuer-ID: 86095742719',
      'Wohnhaft: Birkenweg 14, 80331 München',
      '',
      'Sehr geehrte Frau Hartmann,',
      '',
      'bei der Kontrolle am 20.10.2026 haben wir die Diagnose E11.9 (Diabetes mellitus Typ 2) bestätigt. Die Blutzuckerwerte sind unter der aktuellen Therapie stabil. Wir empfehlen weiterhin Metformin 850 mg 1-0-1 sowie Ramipril 5 mg morgens.',
      '',
      'Die nächste Kontrolle ist in drei Monaten vorgesehen. Bei Beschwerden erreichen Sie uns unter praxis@weidner-allgemeinmedizin.de.',
      '',
      'Mit freundlichen Grüßen',
      'Dr. Jonas Weidner',
      '',
      'Kopie an: Lena Kowalski, Hausärztliche Praxisgemeinschaft',
    ].join('\n'),
  },
  {
    id: 'support',
    label: 'Support ticket',
    blurb: 'English support ticket with secrets pasted in: key, IP, URL, card.',
    names: ['Daniel Ashford', 'Daniel', 'Priya Raman'],
    text: [
      'Subject: Checkout fails with 401 since Tuesday',
      '',
      'From: Daniel Ashford <daniel.ashford@brightlane-shop.com>',
      'Ticket: #48213',
      'Priority: High',
      '',
      'Hi team,',
      '',
      'our checkout stopped working on 20 Oct. I pasted the config below so you can see what we send. Server is 203.0.113.42, the admin panel is at https://deploy:Hunter2pass@admin.brightlane-shop.com/panel',
      '',
      'API_KEY=sk-ant-api03-AbCdEf1234567890',
      'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE',
      '',
      'The test customer used card 4111 1111 1111 1111 and it still fails. You can reach me on +44 20 7946 0958 if that is quicker.',
      '',
      'Thanks,',
      'Daniel Ashford',
      'Brightlane Shop',
      '',
      '--',
      'Reply from Priya Raman (Support): thanks Daniel, looking into it now.',
    ].join('\n'),
  },
  {
    id: 'onboarding',
    label: 'HR onboarding',
    blurb: 'English HR email: dates of birth, bank details, tax and contact data.',
    names: ['Oliver Fenwick', 'Oliver', 'Maria Santos'],
    text: [
      'Subject: Welcome to Harbourline, your onboarding details',
      '',
      'Hi Oliver,',
      '',
      'welcome to the team. Your first day is Monday 2 November 2026. Maria Santos from HR will meet you at reception at 9:30.',
      '',
      'To set up payroll we have the following on file. Please check it and reply if anything is wrong:',
      '',
      'Name: Oliver Fenwick',
      'Date of birth: 12.05.1991',
      'Home address: Gartenstr. 22, 50667 Köln',
      'Mobile: +49 171 1234567',
      'Personal email: oliver.fenwick@example.org',
      'IBAN: DE89 3704 0044 0532 0130 00',
      'Tax ID: 65929970489',
      '',
      'Your work laptop will be registered under the device address 00:1A:2B:3C:4D:5E and your account is oliver.fenwick@harbourline.example.',
      '',
      'Best regards,',
      'Maria Santos',
      'People & Culture, Harbourline Ltd',
      'maria.santos@harbourline.example',
    ].join('\n'),
  },
];
