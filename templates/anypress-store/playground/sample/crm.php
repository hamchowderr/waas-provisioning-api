<?php
/**
 * FluentCRM, on the store's own lifecycle (crm/setup.php and the lifecycle mu-plugin): every sample person as a
 * contact with a phone, city and company, the "<offering>: Interested / Active / Past" tags for what this site type
 * offers (buyers, bookers and members already have theirs from the parts before), the customer group field, the
 * Newsletter list for those who said yes, notes, two draft campaigns, and the site type's welcome automations
 * published with contacts moving through them. The other automations stay drafts, as on a store.
 */
use FluentCrm\App\Models\Funnel;
use FluentCrm\App\Models\FunnelSequence;
use FluentCrm\App\Models\FunnelSubscriber;
use FluentCrm\App\Models\Lists;
use FluentCrm\App\Models\Subscriber;
use FluentCrm\App\Models\SubscriberNote;

$offering = static fn (string $kind) => class_exists('AnyPress_CRM_Lifecycle') ? (AnyPress_CRM_Lifecycle::offering($kind) ?: 'Enquiry') : 'Enquiry';
$kinds = $sample['kinds'] ?: ['enquiry'];
$stages = ['Interested', 'Active', 'Interested', 'Active', 'Past', 'Interested', 'Active', 'Interested'];
$newsletter = Lists::where('slug', 'newsletter')->first();

foreach ($sample['people'] as $i => $p) {
    $existing = Subscriber::where('email', anypress_sample_email($p))->first();
    $subscribed = $i % 3 !== 2;
    $contact = [
        'first_name' => $p[0],
        'last_name' => $p[1],
        'email' => anypress_sample_email($p),
        'phone' => '+1 555 02' . str_pad((string) $i, 2, '0', STR_PAD_LEFT),
        'city' => $p[2],
        'country' => 'US',
        'status' => $subscribed ? 'subscribed' : 'transactional',
        'custom_values' => ['customer_group' => $p[3] ? 'Already in business' : 'Just starting out', 'source' => $existing ? 'checkout' : ['contact form', 'newsletter', 'referral'][$i % 3]],
    ];
    // People the other parts haven't tagged get an interest in what the business offers.
    if (!$existing || !$existing->tags()->exists()) {
        $contact['tags'] = [$offering($kinds[$i % count($kinds)]) . ': ' . $stages[$i % count($stages)]];
    }
    if ($newsletter && $subscribed) {
        $contact['lists'] = [(int) $newsletter->id];
    }
    $saved = FluentCrmApi('contacts')->createOrUpdate($contact, true);
    if ($saved && $i % 4 === 0) {
        SubscriberNote::create([
            'subscriber_id' => $saved->id,
            'type' => ['note', 'call', 'email', 'meeting'][($i / 4) % 4],
            'title' => ['First chat', 'Follow-up call', 'Sent the price list', 'Met at the market'][($i / 4) % 4],
            'description' => '<p>' . ['Interested, wants to start next month.', 'Asked about group rates. Call back Friday.', 'Sent prices and two examples. Waiting to hear back.', 'Lovely to meet in person. Might refer a friend.'][($i / 4) % 4] . '</p>',
            'created_by' => 1,
            'created_at' => anypress_sample_when(2 + $i, 15),
        ]);
    }
}

// The site type's welcome automations, published, with the contacts they would have started for.
$welcome = [
    'enquiry' => ['Nurture: Just starting out', 'Nurture: Already in business'],
    'order' => ['Thank you: Shop', 'Abandoned checkout'],
    'booking' => ['Welcome: Bookings'],
    'space' => ['Welcome: Community'],
    'course' => ['Welcome: Course'],
];
$titles = [];
foreach ($kinds as $kind) {
    $titles = array_merge($titles, $welcome[$kind] ?? []);
}
$contacts = Subscriber::where('status', 'subscribed')->orderBy('id')->get();
foreach (array_unique($titles) as $f => $title) {
    $funnel = Funnel::where('title', $title)->first();
    if (!$funnel) {
        continue;
    }
    $funnel->status = 'published';
    $funnel->save();
    $first = FunnelSequence::where('funnel_id', $funnel->id)->orderBy('sequence', 'ASC')->first();
    foreach ($contacts->slice($f * 3, 5)->values() as $n => $contact) {
        FunnelSubscriber::create([
            'funnel_id' => $funnel->id,
            'subscriber_id' => $contact->id,
            'starting_sequence_id' => $first ? $first->id : 0,
            'next_sequence_id' => $first ? $first->id : 0,
            'status' => $n < 2 ? 'completed' : 'active',
            'type' => 'funnel',
            'source_trigger_name' => $funnel->trigger_name,
            'last_executed_time' => anypress_sample_when(4 - $n),
            'next_execution_time' => $n < 2 ? null : anypress_sample_when(-1 - $n),
        ]);
    }
}

// Two campaigns waiting to be sent.
foreach ([
    ['November newsletter', 'What we have been up to this month', "<p>Hi {{contact.first_name}},</p><p>Here is what is new at {$sample['business']['name']} this month, and one tip we think you will like.</p>"],
    ['Holiday hours', 'Our holiday hours', '<p>Hi {{contact.first_name}},</p><p>We are closed from December 24 to January 1. Bookings and orders open again on January 2.</p>'],
] as [$title, $subject, $body]) {
    \FluentCrm\App\Models\Campaign::create([
        'title' => $title,
        'email_subject' => $subject,
        'email_pre_header' => '',
        'email_body' => $body,
        'design_template' => 'simple',
        'status' => 'draft',
        'settings' => ['mailer_settings' => ['from_name' => '', 'from_email' => '', 'reply_to_name' => '', 'reply_to_email' => '', 'is_custom' => 'no'], 'subscribers' => [['list' => $newsletter ? (string) $newsletter->id : 'all', 'tag' => 'all']], 'excludedSubscribers' => [], 'sending_filter' => 'list_tag', 'dynamic_segment' => ['id' => '', 'slug' => '']],
    ]);
}
