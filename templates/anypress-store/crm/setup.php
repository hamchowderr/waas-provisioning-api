<?php
/**
 * The CRM a new site starts with, shared by the store and storefront templates (run by build.sh after presets.php,
 * with the template's own emails.json next to it):
 *   - the Newsletter list (lists are consent) and the contact fields the lifecycle relies on;
 *   - the contact form's "What best describes you?" and "What can we help with?" questions and its newsletter box;
 *   - abandoned checkout tracking for FluentCart, tagging "<order offering>: Interested";
 *   - the win-back coupon;
 *   - the lifecycle automations from emails.json, all as drafts, and a newsletter email template.
 * Tags (Offering: Interested / Active / Past) are added by mu-plugins/anypress-crm-lifecycle.php as things happen.
 * Nothing sends until the owner publishes an automation in FluentCRM.
 *   wp eval-file setup.php --user=waas-admin
 */
if (!defined('FLUENTCRM')) {
    echo "FluentCRM isn't active\n";
    return;
}
use FluentCrm\App\Models\Funnel;
use FluentCrm\App\Models\FunnelCampaign;
use FluentCrm\App\Models\Lists;
use FluentCrm\App\Models\Tag;

$offerings = array_merge([
    'subscription' => 'Subscription',
    'order' => 'Shop',
    'enquiry' => 'Enquiry',
], (array) get_option('anypress_crm_offerings', []));

// Lists are consent: only people who asked for email. Tags and the list from before the lifecycle model go.
$newsletter = Lists::where('slug', 'newsletter')->first()
    ?: Lists::create(['title' => 'Newsletter', 'slug' => 'newsletter', 'description' => 'People who asked for tips and news by email.']);
foreach (['Customer', 'Lead', 'Subscriber'] as $title) {
    $old = Tag::where('title', $title)->first();
    if ($old && !$old->totalCount()) {
        $old->delete();
    }
}
$customers = Lists::where('slug', 'customers')->first();
if ($customers && !$customers->totalCount()) {
    $customers->delete();
}
echo "List: Newsletter is #{$newsletter->id}\n";

// Contact fields: where they came from, which group they're in, and whether a full refund took a purchase back.
$fields = fluentcrm_get_option('contact_custom_fields', []);
$have = array_column($fields, 'slug');
foreach (['source' => 'Source', 'customer_group' => 'Customer group', 'refunded' => 'Refunded'] as $slug => $label) {
    if (!in_array($slug, $have, true)) {
        $fields[] = ['field_key' => 'text', 'type' => 'text', 'label' => $label, 'slug' => $slug, 'group' => 'Lifecycle'];
    }
}
(new \FluentCrm\App\Models\CustomContactField())->saveGlobalFields($fields);

// The interest tag for the contact form and abandoned checkouts, so the owner sees it in FluentCRM from the start.
$interest = Tag::where('title', $offerings['order'] . ': Interested')->first()
    ?: Tag::create(['title' => $offerings['order'] . ': Interested', 'slug' => sanitize_title($offerings['order'] . ': Interested')]);
if ($offerings['enquiry'] !== $offerings['order'] && !Tag::where('title', $offerings['enquiry'] . ': Interested')->exists()) {
    Tag::create(['title' => $offerings['enquiry'] . ': Interested', 'slug' => sanitize_title($offerings['enquiry'] . ': Interested')]);
}

// The contact form (Fluent Forms' "Contact Form Demo", renamed): two questions and an unticked newsletter box
// before the message. The CRM plugin reads them by name; the answers to "What best describes you?" are the customer
// groups, one nurture automation each, so the owner edits both together.
$form = defined('FLUENTFORM') ? wpFluent()->table('fluentform_forms')->whereIn('title', ['Contact Form Demo', 'Contact form'])->first() : null;
if ($form) {
    $structure = json_decode($form->form_fields, true);
    $names = array_column(array_map(fn($f) => $f['attributes'] ?? [], $structure['fields']), 'name');
    $choice = fn(array $values) => array_map(fn($v, $i) => ['label' => $v, 'value' => $v, 'calc_value' => '', 'image' => '', 'id' => $i], $values, array_keys($values));
    $none = ['type' => 'any', 'status' => false, 'conditions' => [['field' => '', 'value' => '', 'operator' => '']]];
    $select = fn(string $name, string $label, array $values, string $key) => [
        'index' => 2,
        'element' => 'select',
        'attributes' => ['name' => $name, 'value' => '', 'id' => '', 'class' => ''],
        'settings' => [
            'label' => $label, 'admin_field_label' => '', 'help_message' => '', 'container_class' => '', 'label_placement' => '',
            'placeholder' => '- Select -', 'advanced_options' => $choice($values), 'calc_value_status' => false, 'enable_image_input' => false,
            'randomize_options' => 'no', 'enable_select_2' => 'no',
            'validation_rules' => ['required' => ['value' => false, 'message' => 'This field is required']], 'conditional_logics' => $none,
        ],
        'editor_options' => ['title' => 'Dropdown', 'icon_class' => 'ff-edit-dropdown', 'element' => 'select', 'template' => 'select'],
        'uniqElKey' => 'el_anypress_' . $key,
    ];
    $add = [];
    if (!in_array('customer_group', $names, true)) {
        $add[] = $select('customer_group', 'What best describes you?', ['Just starting out', 'Already in business'], 'group');
    }
    if (!in_array('interest', $names, true)) {
        // "A booking" shows only on sites that take bookings (the CRM plugin hides it elsewhere).
        $add[] = $select('interest', 'What can we help with?', ['A question', 'A booking', 'Something else'], 'interest');
    }
    $message = array_search('message', $names, true);
    array_splice($structure['fields'], $message === false ? count($structure['fields']) : $message, 0, $add);
    if (!in_array('newsletter', $names, true)) {
        $structure['fields'][] = [
            'index' => 9,
            'element' => 'input_checkbox',
            'attributes' => ['type' => 'checkbox', 'name' => 'newsletter', 'value' => []],
            'settings' => [
                'dynamic_default_value' => '', 'container_class' => '', 'label' => 'Newsletter', 'admin_field_label' => 'Newsletter',
                'label_placement' => 'hide_label', 'display_type' => '', 'help_message' => '',
                'advanced_options' => [['label' => 'Send me tips and news by email (you can stop any time)', 'value' => 'yes', 'calc_value' => '', 'image' => '', 'id' => 0]],
                'calc_value_status' => false, 'enable_image_input' => false, 'values_visible' => false, 'randomize_options' => 'no',
                'validation_rules' => ['required' => ['value' => false, 'message' => 'This field is required', 'global' => true]],
                'conditional_logics' => $none, 'layout_class' => '',
            ],
            'editor_options' => ['title' => 'Check Box', 'icon_class' => 'ff-edit-checkbox-1', 'template' => 'inputCheckable'],
            'uniqElKey' => 'el_anypress_newsletter',
        ];
    }
    $structure['submitButton']['settings']['button_ui']['text'] = 'Send message';
    // The theme's own button (colours, radius, font), not Fluent Forms' blue.
    foreach (['background_color', 'color'] as $colour) {
        $structure['submitButton']['settings'][$colour] = '';
    }
    $structure['submitButton']['attributes']['class'] = 'wp-element-button';
    wpFluent()->table('fluentform_forms')->where('id', $form->id)->update([
        'title' => 'Contact form',
        'form_fields' => wp_json_encode($structure),
        'updated_at' => current_time('mysql'),
    ]);
    update_option('anypress_crm_contact_form', (int) $form->id, true);
    echo "Contact form: #{$form->id} has the group, interest and newsletter questions\n";
}

// Abandoned checkout tracking for FluentCart (free FluentCRM), through FluentCRM's own settings route so its tables
// are made. New contacts from it are "transactional". It runs only for a published abandoned checkout automation.
$get = rest_do_request(new WP_REST_Request('GET', '/fluent-crm/v2/setting/abandon-cart'));
$cart = (array) ($get->get_data()['settings'] ?? []);
$cart['enabled'] = 'yes';
$cart['enabled_providers'] = array_values(array_unique(array_merge((array) ($cart['enabled_providers'] ?? []), ['fluent_cart'])));
$cart['tags_on_cart_abandoned'] = [(string) $interest->id];
$cart['new_contact_status'] = 'transactional';
$save = new WP_REST_Request('POST', '/fluent-crm/v2/setting/abandon-cart');
$save->set_body_params(['settings' => $cart]);
$saved = rest_do_request($save);
echo $saved->is_error() ? 'Abandoned checkout: FAILED ' . wp_json_encode($saved->get_data()) . "\n" : "Abandoned checkout: tracking on, tags {$interest->title}\n";

// The win-back coupon the win-back email names: 20% off the first payment, once per customer, 100 uses in all.
if (class_exists('\FluentCart\App\Models\Coupon') && !\FluentCart\App\Models\Coupon::where('code', 'COMEBACK20')->exists()) {
    \FluentCart\App\Models\Coupon::create([
        'title' => 'Welcome back',
        'code' => 'COMEBACK20',
        'status' => 'active',
        'type' => 'percentage',
        'amount' => 20,
        'stackable' => 'no',
        'show_on_checkout' => 'no',
        'notes' => 'Named in the "Win-back" email automation in FluentCRM. Change both together.',
        'conditions' => ['max_uses' => 100, 'max_per_customer' => 1, 'is_recurring' => 'no', 'apply_to_whole_cart' => 'yes'],
    ]);
    echo "Coupon: COMEBACK20\n";
}

// The automations, each a straight line (wait, email, wait, email), all drafts.
$automations = json_decode((string) file_get_contents(__DIR__ . '/emails.json'), true);
if (!is_array($automations)) {
    echo "emails.json didn't parse\n";
    return;
}
$made = 0;
foreach ($automations as $a) {
    if (Funnel::where('title', $a['title'])->exists()) {
        continue;
    }
    $manual = $a['trigger'] === 'manual';
    $funnel = [
        'title' => $a['title'],
        // Started by the CRM plugin: parked on the registration trigger, for a role nobody has, which the plugin also refuses.
        'trigger_name' => $manual ? 'user_register' : $a['trigger'],
        'settings' => $manual ? ['subscription_status' => 'subscribed'] : $a['settings'],
        'conditions' => $manual ? ['update_type' => 'update', 'user_roles' => [AnyPress_CRM_Lifecycle::STARTED_BY_CODE]] : $a['conditions'],
        'sticky_note' => $a['note'],
    ];
    $sequences = [];
    $id = 1;
    $day = 0;
    foreach ($a['emails'] as $n => $email) {
        if ($email['day'] > $day) {
            $sequences[] = [
                'id' => $id++,
                'type' => 'action',
                'action_name' => 'fluentcrm_wait_times',
                'title' => 'Wait ' . ($email['day'] - $day) . ' days',
                'description' => '',
                'settings' => ['wait_type' => 'unit_wait', 'wait_time_amount' => $email['day'] - $day, 'wait_time_unit' => 'days'],
            ];
            $day = $email['day'];
        }
        $campaign = FunnelCampaign::getMock();
        $campaign['title'] = $email['subject'];
        $campaign['email_subject'] = $email['subject'];
        $campaign['email_pre_header'] = $email['preheader'];
        $campaign['email_body'] = $email['body'];
        $campaign['settings'] = (array) $campaign['settings'];
        $sequences[] = [
            'id' => $id++,
            'type' => 'action',
            'action_name' => 'send_custom_email',
            'title' => 'Email ' . ($n + 1) . ': ' . $email['subject'],
            'description' => '',
            'settings' => [
                'send_email_to_type' => 'contact',
                'send_email_custom' => '',
                'campaign' => $campaign,
                'is_scheduled' => 'no',
                'scheduled_at' => '',
                'skip_if_overdue' => 'no',
            ],
        ];
    }
    $request = new WP_REST_Request('POST', '/fluent-crm/v2/funnels/import');
    $request->set_body_params(['funnel' => $funnel, 'sequences' => wp_json_encode($sequences)]);
    $response = rest_do_request($request);
    $data = $response->get_data();
    if ($response->is_error() || empty($data['funnel'])) {
        echo "Automation: {$a['title']} FAILED: " . (is_array($data) ? ($data['message'] ?? wp_json_encode($data)) : $data) . "\n";
        exit(1);
    }
    $made++;
}
echo "Automations: $made added as drafts\n";

// The newsletter, an email template (FluentCRM > Emails > Templates) the owner copies into a campaign each month.
$slug = fluentcrmTemplateCPTSlug();
if (!get_posts(['post_type' => $slug, 'title' => 'Newsletter', 'post_status' => 'any', 'numberposts' => 1])) {
    $id = wp_insert_post([
        'post_type' => $slug,
        'post_status' => 'publish',
        'post_title' => 'Newsletter',
        'post_content' => '<p>Hi {{contact.first_name|there}},</p>'
            . '<h3>What is new</h3><p>One thing that changed or arrived this month, in two or three sentences.</p>'
            . '<h3>A tip</h3><p>One small, useful thing your readers can do this week.</p>'
            . '<h3>Worth a look</h3><p>One example, story or idea, with a link.</p>'
            . '<p>{{crm.business_name}}</p>',
    ]);
    update_post_meta($id, '_email_subject', 'News from {{crm.business_name}}');
    update_post_meta($id, '_edit_type', 'html');
    update_post_meta($id, '_template_config', \FluentCrm\App\Services\Helper::getTemplateConfig('simple'));
    update_post_meta($id, '_design_template', 'simple');
    echo "Template: Newsletter\n";
}
