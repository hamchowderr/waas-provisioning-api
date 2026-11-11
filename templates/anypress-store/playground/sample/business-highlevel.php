<?php
/**
 * The HighLevel demo: Summit Roofing, a local roofing company whose leads, emails and follow-ups live in HighLevel.
 * The site carries the blog, project write-ups and the quote request; there is no FluentCRM newsletter here.
 *
 * Posts: [title, category, writer, image, body]. In a body, a blank line starts a paragraph, "## " a heading and
 * "- " a list item.
 */
return [
    'name' => 'Summit Roofing',
    'tagline' => 'Roof repairs and replacements, done right',
    'kinds' => [],
    'writers' => [
        ['Owen', 'Price', 'Owner. Twenty years on roofs, the last ten running Summit.'],
        ['Lila', 'Hayes', 'Office manager. Schedules every inspection and answers the phone.'],
        ['Tomas', 'Duarte', 'Crew lead. Takes the before and after photos.'],
    ],
    'categories' => [
        'Roof care' => 'Simple ways to make your roof last longer.',
        'Projects' => 'Before and after, from jobs around town.',
        'Storm season' => 'Getting ready for bad weather, and what to do after.',
        'Company news' => 'Hiring, offers and what is new at Summit.',
    ],
    'posts' => [
        ['Five signs your roof needs a check', 'Roof care', 0, 'roof house', "Most roof problems are cheap to fix if you catch them early. Look out for these five.\n\n- Missing or curled shingles\n- Dark patches on a ceiling\n- Granules in the gutters, like coarse sand\n- Daylight through the attic boards\n- A roof over twenty years old\n\nSee one? Book a free inspection. We will send photos of anything we find."],
        ['Repair or replace? How we decide', 'Roof care', 0, 'roof', "If the damage covers less than a third of the roof and the decking underneath is sound, we repair. Otherwise, we talk about replacing.\n\nWe show you photos either way, and we never push a replacement you do not need. A good repair can add ten years."],
        ['Before and after: a 1950s bungalow', 'Projects', 2, 'house', "A full tear-off, new decking where the old boards had rotted, and architectural shingles in charcoal. Three days, one dumpster, no rain.\n\nThe owners had been putting buckets in the attic for two winters. Not any more."],
        ['Storm season checklist', 'Storm season', 1, 'storm clouds', "Before the storms arrive, spend an afternoon on these.\n\n- Clear the gutters and downpipes\n- Trim branches that hang over the roof\n- Photograph your roof from the ground, for insurance\n- Save our number in your phone\n\nIf a storm does damage, cover what you can with a tarp and call us. We prioritise leaks."],
        ['How long does a roof replacement take?', 'Roof care', 0, 'construction workers', "Most homes take two to three days. Day one is the tear-off and any decking repairs. Day two is underlayment and shingles. Day three, if needed, is flashing, vents and clean-up.\n\nWe sweep the yard with a magnet for nails before we leave."],
        ['We are hiring roofers', 'Company news', 1, 'builder', "Full-time roles with training, a company truck and health cover. No experience needed for apprentices; we will teach you.\n\nCall the office and ask for Owen."],
        ['Before and after: storm damage on Maple Street', 'Projects', 2, 'construction', "A fallen branch took out a section of shingles and cracked two rafters. We tarped it the same night, then rebuilt the section and matched the shingles to the rest of the roof.\n\nThe insurer paid in full. We sent them our photos and report the next morning."],
        ['What is underlayment, and why does it matter?', 'Roof care', 0, 'roof shingles', "Underlayment is the waterproof layer between the wooden deck and the shingles. If a shingle fails, it is what keeps the water out.\n\nWe use synthetic underlayment on every job. It costs a little more than felt and lasts much longer."],
        ['Gutter guards: worth it?', 'Roof care', 1, 'rain', "If you have tall trees nearby, yes. Guards keep leaves out so gutters do not overflow and soak your fascia.\n\nIf you do not, a clean twice a year is cheaper. We can do either."],
        ['Free inspections this month', 'Company news', 1, 'house roof sky', "Book online and we will send someone within the week. You get photos of every part of your roof and an honest note on what, if anything, needs doing."],
        ['Before and after: a new metal roof', 'Projects', 2, 'metal roof', "Standing seam steel in dark grey on a 1970s ranch. Metal costs more up front but lasts fifty years and sheds snow like nothing else.\n\nThe owners say the rain sounds cosy now."],
        ['How to read a roofing quote', 'Roof care', 0, 'paperwork', "A good quote lists the materials by name, the area in squares, what happens to rotten decking, the warranty and the clean-up. If any of those are missing, ask.\n\nOurs fit on one page, with photos attached."],
        ['After the storm: what to do first', 'Storm season', 1, 'storm', "Stay safe and stay off the roof. Take photos from the ground. Move valuables away from any leaks, put down buckets, and call your insurer and us.\n\nWe can tarp most roofs within 24 hours of a storm."],
        ['Meet Tomas, our crew lead', 'Company news', 1, 'worker', "Tomas has been with Summit for eight years and has led more than three hundred jobs. He takes every before and after photo you see on this site.\n\nIf you see him, ask about his dog. She has her own hard hat."],
        ['Skylights: add light without the leaks', 'Projects', 2, 'skylight', "A well-fitted skylight floods a room with light. A badly fitted one leaks. The difference is the flashing.\n\nWe fit the manufacturer's flashing kit every time, and check it again after the first heavy rain."],
        ['Winter roof care in four steps', 'Storm season', 0, 'snow roof', "Clear the gutters before the first freeze, watch for ice dams along the edge, keep the attic cold and well vented, and brush heavy snow off with a roof rake, never a shovel."],
        ['Ten years of Summit Roofing', 'Company news', 0, 'celebration team', "Ten years ago it was me and a borrowed ladder. Today we are a crew of twelve with four trucks.\n\nThank you to every neighbour who trusted us with their home."],
        ['Before and after: a church roof', 'Projects', 2, 'church', "Our biggest job this year: slate repairs and new copper flashing on a hundred-year-old church. It took three weeks and a very tall scaffold. The bell still works."],
    ],
    'drafts' => [
        ['Solar panels and your roof', 'Roof care', 0, "Notes: check roof age before solar, add 10 years of life first, coordinate with installer on penetrations."],
    ],
    'scheduled' => [
        ['Spring inspection specials', 'Company news', 1, 'spring house', "Spring is the best time to check for winter damage. Book an inspection in March and we will clean your gutters for free."],
    ],
    'comments' => [
        'Had Summit out last month. Professional and tidy.',
        'Great checklist, sharing with my neighbours.',
        'Do you work in the next county too?',
        'The before and after photos are amazing.',
        'Tomas and the crew were fantastic.',
        'How much does a typical inspection cost?',
        'Congrats on ten years!',
        'Booked my free inspection.',
        'Very helpful explanation of underlayment.',
        'The tarp saved us after the storm. Thank you!',
    ],
    'replies' => [
        'Thank you for trusting us!',
        'Yes, we cover the whole county and the next one over.',
        'Inspections are always free.',
        'We will pass that on to the crew.',
        'Glad we could help.',
    ],
    'video' => 'What happens on install day',
    'snippet' => ['Emergency line in the header', "add_action('wp_body_open', function () {\n    echo '<p class=\"emergency\">Storm damage? Call us any time</p>';\n});"],
    // The public pages: [section title, items] and buttons as [label, page slug, '#anchor' or 'portal'].
    'pages' => [
        // The hero's photo: the blog post whose photo it uses.
        'photo' => 2,
        'hero' => 'Roof repairs and replacements, done right. Free inspections with photos of everything we find, across the county.',
        'buttons' => [['Book a free inspection', 'contact'], ['Our services', 'services']],
        'features' => ['Why homeowners call Summit', [
            ['Free inspections', 'Photos of every part of your roof and an honest note on what, if anything, needs doing.'],
            ['Storm response', 'We tarp most roofs within 24 hours of a storm, and send your insurer our report.'],
            ['Ten-year workmanship warranty', 'On every replacement, on top of the manufacturer\'s warranty.'],
        ]],
        'blog' => ['Roof care tips', 'Roof care tips and projects'],
        'faq' => ['Questions we get', [
            ['How much does an inspection cost?', 'Nothing. Inspections are always free.'],
            ['How long does a replacement take?', 'Two to three days for most homes, including clean-up.'],
            ['Do you work with insurers?', 'Yes. We send photos and a written report the morning after we visit.'],
        ]],
        'cta' => ['Storm damage?', 'Call us any time. We prioritise leaks and can tarp most roofs the same day.', [['Contact us', 'contact']]],
        'about' => ['Ten years of Summit Roofing', [
            'Owen spent ten years on other people\'s crews before starting Summit with one truck and a borrowed ladder. Today we are a crew of twelve with four trucks.',
            'Lila runs the office and schedules every inspection. Tomas leads the crew and takes the before and after photos you see on this site.',
        ], [
            ['Photos, always', 'You see what we see, before we quote.'],
            ['No upselling', 'If a repair will do, we say so.'],
            ['Clean sites', 'We sweep the yard with a magnet for nails before we leave.'],
        ]],
        'contact' => [['Phone', '(816) 555-0193, any time for storm damage.'], ['Email', 'office@summitroofing.example'], ['Area', 'Kansas City and the surrounding counties.']],
        'services' => ['Services', 'services', 'From a single missing shingle to a whole new roof.', [
            ['Repairs', 'Leaks, missing shingles, flashing and storm damage, usually fixed in a day.'],
            ['Replacements', 'Asphalt, architectural shingle and standing seam metal, with a ten-year warranty.'],
            ['Gutters and skylights', 'Gutter guards, new gutters and skylights fitted without the leaks.'],
        ]],
    ],
];
