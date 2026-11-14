<?php
/**
 * The newsletter, running for six months: past issues sent to everyone on the Newsletter list at the time, with
 * opens, clicks and a few unsubscribes; the next issue scheduled and one in draft; the welcome series new subscribers
 * go through; and the sign-up form's entries.
 */
use FluentCrm\App\Models\Campaign;
use FluentCrm\App\Models\CampaignEmail;
use FluentCrm\App\Models\CampaignUrlMetric;
use FluentCrm\App\Models\Funnel;
use FluentCrm\App\Models\FunnelCampaign;
use FluentCrm\App\Models\FunnelSequence;
use FluentCrm\App\Models\FunnelSubscriber;
use FluentCrm\App\Models\Lists;
use FluentCrm\App\Models\Subscriber;
use FluentCrm\App\Models\UrlStores;

$letter = $sample['newsletter'];
$list = Lists::where('slug', 'newsletter')->first();
if (!$list) {
    return;
}
$business = $sample['business']['name'];
$settings = [
    'mailer_settings' => ['from_name' => '', 'from_email' => '', 'reply_to_name' => '', 'reply_to_email' => '', 'is_custom' => 'no'],
    'subscribers' => [['list' => (string) $list->id, 'tag' => 'all']],
    'excludedSubscribers' => [],
    'sending_filter' => 'list_tag',
    'dynamic_segment' => ['id' => '', 'slug' => ''],
];
/** An issue: the intro, then the posts that went out since the issue before, then the sign-off. */
$body = static function (string $intro, array $posts) use ($business): string {
    $html = '<p>Hi {{contact.first_name|there}},</p><p>' . esc_html($intro) . '</p>';
    if ($posts) {
        $html .= '<h3>New on the blog</h3>';
        foreach ($posts as $post) {
            $html .= '<p><a href="' . esc_url(get_permalink($post)) . '"><strong>' . esc_html(get_the_title($post)) . '</strong></a><br>' . esc_html(get_the_excerpt($post)) . '</p>';
        }
    }
    return $html . '<p>Thanks for reading,<br>' . esc_html($business) . '</p>';
};
$postsBetween = static fn (string $from, string $to) => get_posts([
    'post_type' => 'post', 'post_status' => 'publish', 'numberposts' => 3, 'orderby' => 'date', 'order' => 'DESC', 'fields' => 'ids',
    'date_query' => [['after' => $from, 'before' => $to, 'inclusive' => true, 'column' => 'post_date_gmt']],
]);
// The same open and click rates every time the demo is made.
$chance = static fn (string $seed) => hexdec(substr(md5($seed), 0, 6)) / 0xFFFFFF;

// Past issues, oldest first, every couple of weeks (or month) at 2pm.
$issues = $letter['issues'];
$every = (int) ($letter['every'] ?? 30);
$last = count($issues) - 1;
$previous = anypress_sample_when(($last + 1) * $every + 3);
foreach ($issues as $n => [$subject, $preheader, $intro]) {
    $daysAgo = ($last - $n) * $every + 2;
    $sentAt = anypress_sample_when($daysAgo, 14);
    $campaign = Campaign::create([
        'title' => $letter['name'] . ': ' . $subject,
        'email_subject' => $subject,
        'email_pre_header' => $preheader,
        'email_body' => $body($intro, $postsBetween($previous, $sentAt)),
        'design_template' => 'simple',
        'status' => 'archived',
        'scheduled_at' => $sentAt,
        'settings' => $settings,
    ]);
    $previous = $sentAt;
    // Everyone subscribed to the list on the day it went out.
    $recipients = $list->subscribers()->where('fc_subscribers.created_at', '<', $sentAt)->get();
    if (!count($recipients)) {
        continue;
    }
    $campaign->subscribe($recipients, [], true);
    CampaignEmail::where('campaign_id', $campaign->id)->update(['status' => 'sent', 'scheduled_at' => $sentAt, 'created_at' => $sentAt, 'updated_at' => $sentAt]);
    $campaign->recipients_count = count($recipients);
    $campaign->created_at = anypress_sample_when($daysAgo + 2, 11);
    $campaign->updated_at = $sentAt;
    $campaign->save();

    $link = UrlStores::getUrlSlug(home_url('/blog/'));
    $urlId = (int) (UrlStores::getRowByShort($link)->id ?? 0);
    $opened = [];
    $clicked = [];
    foreach (CampaignEmail::where('campaign_id', $campaign->id)->get(['id', 'subscriber_id']) as $email) {
        $roll = $chance($campaign->id . '-' . $email->subscriber_id);
        if ($roll < 0.47) {
            $opened[] = $email->id;
            CampaignUrlMetric::maybeInsert(['campaign_id' => $campaign->id, 'subscriber_id' => $email->subscriber_id, 'type' => 'open', 'ip_address' => '', 'created_at' => $sentAt]);
        }
        if ($roll < 0.09) {
            $clicked[] = $email->id;
            CampaignUrlMetric::maybeInsert(['campaign_id' => $campaign->id, 'subscriber_id' => $email->subscriber_id, 'url_id' => $urlId, 'type' => 'click', 'ip_address' => '', 'created_at' => $sentAt]);
        }
        // One or two people leave the list after some issues.
        if ($roll > 0.985 && $n % 2 === 1) {
            $leaving = Subscriber::find($email->subscriber_id);
            if ($leaving && $leaving->status === 'subscribed') {
                $leaving->updateStatus('unsubscribed');
                CampaignUrlMetric::maybeInsert(['campaign_id' => $campaign->id, 'subscriber_id' => $email->subscriber_id, 'type' => 'unsubscribe', 'ip_address' => '', 'created_at' => $sentAt]);
            }
        }
    }
    if ($opened) {
        CampaignEmail::whereIn('id', $opened)->update(['is_open' => 1]);
    }
    if ($clicked) {
        CampaignEmail::whereIn('id', $clicked)->update(['click_counter' => 1]);
    }
}

// The next issue, scheduled for later this week, and one still in draft.
foreach (['next' => 'scheduled', 'draft' => 'draft'] as $key => $status) {
    if (empty($letter[$key])) {
        continue;
    }
    [$subject, $preheader, $intro] = $letter[$key];
    Campaign::create([
        'title' => $letter['name'] . ': ' . $subject,
        'email_subject' => $subject,
        'email_pre_header' => $preheader,
        'email_body' => $body($intro, $status === 'scheduled' ? $postsBetween($previous, anypress_sample_when(0, 23)) : []),
        'design_template' => 'simple',
        'status' => $status,
        'scheduled_at' => $status === 'scheduled' ? anypress_sample_when(-4, 14) : null,
        'settings' => $settings,
    ]);
}

// The welcome series: a published automation that starts when someone joins the list, with the newest subscribers in it.
if (!empty($letter['welcome']) && !Funnel::where('title', 'Welcome: ' . $letter['name'])->exists()) {
    $sequences = [];
    $id = 1;
    $day = 0;
    foreach ($letter['welcome'] as $n => [$at, $subject, $preheader, $html]) {
        if ($at > $day) {
            $sequences[] = ['id' => $id++, 'type' => 'action', 'action_name' => 'fluentcrm_wait_times', 'title' => 'Wait ' . ($at - $day) . ' days', 'description' => '',
                'settings' => ['wait_type' => 'unit_wait', 'wait_time_amount' => $at - $day, 'wait_time_unit' => 'days']];
            $day = $at;
        }
        $mail = FunnelCampaign::getMock();
        $mail['title'] = $subject;
        $mail['email_subject'] = $subject;
        $mail['email_pre_header'] = $preheader;
        $mail['email_body'] = $html;
        $mail['settings'] = (array) $mail['settings'];
        $sequences[] = ['id' => $id++, 'type' => 'action', 'action_name' => 'send_custom_email', 'title' => 'Email ' . ($n + 1) . ': ' . $subject, 'description' => '',
            'settings' => ['send_email_to_type' => 'contact', 'send_email_custom' => '', 'campaign' => $mail, 'is_scheduled' => 'no', 'scheduled_at' => '', 'skip_if_overdue' => 'no']];
    }
    $request = new WP_REST_Request('POST', '/fluent-crm/v2/funnels/import');
    $request->set_body_params([
        'funnel' => [
            'title' => 'Welcome: ' . $letter['name'],
            'trigger_name' => 'fluentcrm_contact_added_to_lists',
            'settings' => ['lists' => [(string) $list->id], 'select_type' => 'any'],
            'conditions' => ['run_multiple' => 'no'],
            'sticky_note' => 'Everyone who joins the Newsletter list gets these three emails over a week.',
        ],
        'sequences' => wp_json_encode($sequences),
    ]);
    $made = rest_do_request($request)->get_data();
    $funnel = Funnel::find((int) ($made['funnel']['id'] ?? 0));
    if ($funnel) {
        $funnel->status = 'published';
        $funnel->save();
        $steps = FunnelSequence::where('funnel_id', $funnel->id)->orderBy('sequence', 'ASC')->get();
        $joined = $list->subscribers()->where('fc_subscribers.status', 'subscribed')->where('fc_subscribers.created_at', '>', anypress_sample_when(12))->get();
        $welcomes = [];
        foreach ($joined as $contact) {
            $days = (time() - strtotime((string) $contact->created_at)) / DAY_IN_SECONDS;
            $done = $days >= 7;
            $at = $steps[min(count($steps) - 1, $days >= 3 ? 3 : 1)] ?? null;
            FunnelSubscriber::create([
                'funnel_id' => $funnel->id,
                'subscriber_id' => $contact->id,
                'starting_sequence_id' => $steps[0]->id ?? 0,
                'next_sequence_id' => $done ? 0 : ($at->id ?? 0),
                'status' => $done ? 'completed' : 'active',
                'type' => 'funnel',
                'source_trigger_name' => 'fluentcrm_contact_added_to_lists',
                'last_executed_time' => anypress_sample_when(max(0, $days - 3)),
                'next_execution_time' => $done ? null : anypress_sample_when(-1),
                'created_at' => (string) $contact->created_at,
            ]);
            foreach ($letter['welcome'] as [$at, $subject, , $html]) {
                if ($at <= $days) {
                    $welcomes[] = [strtotime((string) $contact->created_at) + $at * DAY_IN_SECONDS + 600, $contact, $subject, $html];
                }
            }
        }
        // The welcome emails they have had so far, in the email log in the order they went.
        usort($welcomes, static fn ($a, $b) => $a[0] <=> $b[0]);
        foreach (defined('FLUENTMAIL') ? $welcomes : [] as [$at, $contact, $subject, $html]) {
            wp_mail($contact->email, $subject, str_replace('{{contact.first_name|there}}', esc_html($contact->first_name), $html), ['Content-Type: text/html; charset=UTF-8']);
            anypress_sample_mail_at(gmdate('Y-m-d H:i:s', min(time() - 300, $at)));
        }
    }
}

// The sign-up form: Fluent Forms' Subscription Form, with an entry for each reader who joined in the last weeks.
if (defined('FLUENTFORM')) {
    $form = \FluentForm\App\Models\Form::where('title', 'Subscription Form')->first();
    if ($form) {
        $form->title = 'Newsletter sign-up';
        $form->save();
        $fields = json_decode($form->form_fields, true)['fields'] ?? [];
        $names = array_column(array_column($fields, 'attributes'), 'name');
        foreach (array_slice(array_reverse($sample['readers']), 0, 14) as $r => $p) {
            $contact = Subscriber::where('email', anypress_sample_email($p))->first();
            $data = ['email' => anypress_sample_email($p)];
            if (in_array('names', $names, true)) {
                $data['names'] = ['first_name' => $p[0], 'last_name' => $p[1]];
            }
            $daysAgo = $contact ? (time() - strtotime((string) $contact->created_at)) / DAY_IN_SECONDS : 1 + $r;
            anypress_sample_entry($form, $data, $daysAgo, $r < 4 ? 'unread' : 'read', false, '/');
        }
    }
}
