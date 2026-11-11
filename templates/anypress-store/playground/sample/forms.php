<?php
/**
 * Fluent Forms: entries on the contact form (read, unread, starred), and one more form for the business made from
 * Fluent Forms' own templates, with its own entries.
 */
use FluentForm\App\Models\Form;
use FluentForm\App\Models\Submission;
use FluentForm\App\Services\Submission\SubmissionService;

/** One entry, as a submission saves it: the entry, its details and its id hash. */
$entry = static function (Form $form, array $data, float $daysAgo, string $status, bool $starred = false): void {
    $previous = (int) Submission::where('form_id', $form->id)->max('serial_number');
    $when = anypress_sample_when($daysAgo, 9 + (int) ($daysAgo * 7) % 9);
    $submission = Submission::create([
        'form_id' => $form->id,
        'serial_number' => $previous + 1,
        'response' => wp_json_encode($data, JSON_UNESCAPED_UNICODE),
        'source_url' => home_url('/contact/'),
        'user_id' => 0,
        'status' => $status,
        'is_favourite' => $starred ? 1 : 0,
        'browser' => ['Chrome', 'Safari', 'Firefox'][(int) $daysAgo % 3],
        'device' => ['Windows', 'iPhone', 'Mac', 'Android'][(int) $daysAgo % 4],
        'country' => 'US',
        'created_at' => $when,
        'updated_at' => $when,
    ]);
    (new SubmissionService())->recordEntryDetails($submission->id, $form->id, $data);
    \FluentForm\App\Helpers\Helper::setSubmissionMeta($submission->id, '_entry_uid_hash', md5(wp_generate_uuid4() . $submission->id), $form->id);
};

$people = $sample['people'];
$name = static fn (array $p) => ['first_name' => $p[0], 'last_name' => $p[1]];

// The contact form (crm/setup.php renamed Fluent Forms' "Contact Form Demo" and added its questions).
$contact = Form::where('id', (int) get_option('anypress_crm_contact_form'))->first();
if ($contact) {
    $messages = [
        ['Quick question about prices', 'A question', 'Hi! Could you send me your prices? I am just starting out and want to plan.'],
        ['Booking for next week', 'A booking', 'Do you have any time on Tuesday or Wednesday afternoon?'],
        ['Partnership idea', 'Something else', 'I run a local business and think our customers overlap. Could we talk?'],
        ['Thank you', 'Something else', 'Just wanted to say thanks for last time. Everything was perfect.'],
        ['Opening hours over the holidays', 'A question', 'Are you open between Christmas and New Year?'],
        ['Help choosing', 'A question', 'Not sure which option suits me. Can someone call me?'],
        ['Group booking', 'A booking', 'We are a team of six. Can we book together?'],
        ['Feedback on the website', 'Something else', 'Love the new site. The contact page was easy to find!'],
    ];
    foreach ($messages as $i => [$subject, $interest, $message]) {
        $p = $people[$i + 2];
        $entry($contact, [
            'names' => $name($p),
            'email' => anypress_sample_email($p),
            'subject' => $subject,
            'customer_group' => $i % 2 ? 'Already in business' : 'Just starting out',
            'interest' => $interest,
            'message' => $message,
            'newsletter' => $i % 3 === 2 ? [] : ['yes'],
        ], 1 + $i * 2.5, $i < 3 ? 'unread' : 'read', $i === 1);
    }
}

// The business's own form, from Fluent Forms' templates.
$spec = $sample['form'] ?? null;
if ($spec) {
    $form = (new \FluentForm\App\Services\Form\FormService())->store(['predefined' => $spec['template'], 'type' => 'form']);
    $form->title = $spec['title'];
    $services = [
        'website' => ['Monthly bookkeeping', 'Year-end accounts', 'Tax return', 'Payroll'],
        'bookings' => ['Massage', 'Coaching', 'Consultation'],
        'community' => ['The community', 'The course', 'The live Q&A'],
    ][$sample['type']] ?? [];
    if ($spec['template'] === 'client_satisfaction_survey_form' && $services) {
        $fields = json_decode($form->form_fields, true);
        $relabel = [
            'dropdown' => ['Which service did you use?', $services],
            'description' => ['What brought you to us?', null],
            'checkbox' => ['What mattered most to you?', ['Friendly people', 'On time', 'Clear prices', 'Easy to book', 'Good advice']],
            'description_1' => ['How could we do better?', null],
            'input_radio' => ['Would you come back?', null],
        ];
        foreach ($fields['fields'] as &$field) {
            $key = $field['attributes']['name'] ?? '';
            if (!isset($relabel[$key])) {
                continue;
            }
            [$label, $options] = $relabel[$key];
            $field['settings']['label'] = $label;
            if ($options) {
                $field['settings']['advanced_options'] = array_map(static fn ($o) => ['label' => $o, 'value' => $o, 'calc_value' => '', 'image' => ''], $options);
            }
        }
        unset($field);
        $form->form_fields = wp_json_encode($fields);
        $form->save();
        $answers = [
            [0, 'A friend recommended you.', [0, 3], 'Nothing, it was great.', 'Definitely'],
            [1, 'I found you on Google.', [1, 2], 'More evening times would help.', 'Definitely'],
            [0, 'I needed help fast.', [4, 0], 'A reminder the day before.', 'Probably'],
            [count($services) - 1, 'Your blog posts.', [2, 4], 'Send the notes after.', 'Definitely'],
        ];
        $checks = ['Friendly people', 'On time', 'Clear prices', 'Easy to book', 'Good advice'];
        foreach ($answers as $i => [$service, $why, $mattered, $better, $again]) {
            $entry($form, [
                'dropdown' => $services[$service],
                'description' => $why,
                'checkbox' => array_map(static fn ($k) => $checks[$k], $mattered),
                'description_1' => $better,
                'input_radio' => $again,
            ], 2 + $i * 4, $i ? 'read' : 'unread');
        }
    } else {
        $form->save();
        $problems = [
            [3, 'Cozy Fleece Hoodie', 'The hoodie is a size too small.', 'Swap it for a large, please.'],
            [6, 'Classic Cap', 'The strap came loose after a week.', 'A replacement would be great.'],
            [9, 'Fleece Jacket', 'Wrong colour arrived (grey instead of navy).', 'Send the navy one and I will return the grey.'],
            [12, 'Basic Men\'s T-Shirt', 'Ordered two, only one in the parcel.', 'Please send the missing one.'],
        ];
        foreach ($problems as $i => [$who, $product, $details, $action]) {
            $p = $people[$who];
            $entry($form, [
                'names' => $name($p),
                'input_text_1' => $product,
                'input_text_2' => 'TC-' . (1040 + $i * 7),
                'address1' => ['address_line_1' => (12 + $i * 31) . ' Main Street', 'address_line_2' => '', 'city' => $p[2], 'state' => '', 'country' => 'US'],
                'input_text' => (string) (10001 + $i * 1234),
                'email' => anypress_sample_email($p),
                'datetime' => gmdate('d/m/Y', strtotime('-' . (2 + $i * 3) . ' days')),
                'description' => $details,
                'description_1' => $action,
            ], 2 + $i * 3, $i < 2 ? 'unread' : 'read', $i === 0);
        }
    }
}
