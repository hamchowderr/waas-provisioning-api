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

// The rest of the mailing list: readers who signed up through the newsletter form over six months, more of them lately.
foreach ($sample['readers'] as $r => $p) {
    $saved = FluentCrmApi('contacts')->createOrUpdate([
        'first_name' => $p[0],
        'last_name' => $p[1],
        'email' => anypress_sample_email($p),
        'city' => $p[2],
        'country' => 'US',
        'status' => 'subscribed',
        'custom_values' => ['source' => $r % 9 === 4 ? 'referral' : 'newsletter form'],
        'lists' => $newsletter ? [(int) $newsletter->id] : [],
    ], true);
    if ($saved) {
        // The first twenty were there before the newsletter started; the rest joined faster as the blog grew.
        $daysAgo = $r < 20 ? 260 - $r * 3.5 : max(0.4, 188 * (1 - sqrt(($r - 19) / (count($sample['readers']) - 19))));
        $when = anypress_sample_when($daysAgo, 7 + $r % 14);
        $saved->created_at = $when;
        $saved->updated_at = $when;
        $saved->save();
    }
}
// The sample people joined over the same months (buyers, bookers and members keep the date their plugin gave them).
foreach ($sample['people'] as $i => $p) {
    $contact = Subscriber::where('email', anypress_sample_email($p))->first();
    if ($contact && strtotime((string) $contact->created_at) > time() - DAY_IN_SECONDS) {
        $when = anypress_sample_when(20 + ($i * 37) % 160, 9 + $i % 9);
        $contact->created_at = $when;
        $contact->save();
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
