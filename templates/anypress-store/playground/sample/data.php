<?php
/**
 * The made-up business behind each site type's demo, and everything it says: people, posts, tickets, bookings, the
 * community. All names are invented and every address is @example.com.
 */
return static function (string $type): array {
    // [first, last, city, company, bio]
    $people = [
        ['Maya', 'Chen', 'Portland', 'Chen Studio', 'Runs a small design studio. Coffee first, then pixels.'],
        ['Daniel', 'Okafor', 'Atlanta', '', 'Weekend woodworker turning a hobby into a shop.'],
        ['Sofia', 'Ramirez', 'Austin', 'Ramirez Catering', 'Caterer, mother of two, always planning the next menu.'],
        ['Liam', 'Walsh', 'Boston', '', 'Photographer. Mostly weddings, sometimes dogs.'],
        ['Aisha', 'Khan', 'Chicago', 'Khan & Co.', 'Bookkeeper by day, potter by night.'],
        ['Noah', 'Bennett', 'Denver', '', 'Trail runner who sells hand-drawn maps.'],
        ['Grace', 'Kim', 'Seattle', 'Kim Florals', 'Florist. Ask me about dried flowers.'],
        ['Lucas', 'Moreau', 'New Orleans', '', 'Musician and part-time music teacher.'],
        ['Hannah', 'Schmidt', 'Minneapolis', 'Northwind Yoga', 'Yoga teacher opening a second studio.'],
        ['Omar', 'Haddad', 'Detroit', '', 'Makes leather goods in a garage workshop.'],
        ['Chloe', 'Dubois', 'San Diego', 'Seaside Bakes', 'Baker. Sourdough is my love language.'],
        ['Ethan', 'Parker', 'Nashville', '', 'Writes songs, builds websites, drinks tea.'],
        ['Priya', 'Nair', 'San Jose', 'Nair Consulting', 'Helps small teams get their numbers right.'],
        ['Mateo', 'Silva', 'Miami', '', 'Personal trainer and smoothie enthusiast.'],
        ['Zoe', 'Thompson', 'Phoenix', 'Desert Bloom', 'Candle maker. Everything smells like sage.'],
        ['Ben', 'Carter', 'Columbus', '', 'Teacher learning to sell his lesson plans.'],
        ['Isla', 'Murphy', 'Pittsburgh', 'Murphy Print Co.', 'Screen printer with too many inks.'],
        ['Jonah', 'Levi', 'Philadelphia', '', 'Coach for first-time founders.'],
        ['Amara', 'Obi', 'Houston', 'Obi Textiles', 'Weaves fabric and stories.'],
        ['Ryan', 'Foster', 'Raleigh', '', 'Software tester, part-time baker.'],
        ['Elena', 'Petrova', 'Sacramento', 'Petrova Translations', 'Translator in four languages.'],
        ['Kai', 'Nakamura', 'Honolulu', '', 'Surf instructor and illustrator.'],
        ['Fatima', 'Ali', 'Dallas', 'Ali Events', 'Plans weddings and big birthdays.'],
        ['Owen', 'Price', 'Kansas City', '', 'BBQ judge and backyard pitmaster.'],
    ];

    $businesses = [
        'website' => [
            'name' => 'Brightline Accounting',
            'tagline' => 'Bookkeeping and tax help for small businesses',
            'kinds' => ['enquiry'],
            'categories' => ['Tax', 'Small business', 'News'],
            'posts' => [
                ['Five receipts you should always keep', 'Tax', "Most of the questions we get in spring come down to one missing receipt. Here are the five we ask for every year, and the easiest way to keep them in one place.\n\nA folder on your phone is fine. What matters is that every receipt has a date, an amount and a reason."],
                ['What changes at year end, in plain words', 'Tax', "December is busy for a reason. A few things only count if they happen before the year closes, and a few are better left until January.\n\nWe walk through both lists and the one question to ask before you buy anything big."],
                ['How we set up a new client in a week', 'Small business', "Day one is a call. Day two we connect your bank feeds. By the end of the week you have clean books and a monthly date in the calendar.\n\nThis is the checklist we follow, so you know what to have ready."],
                ['Separate your business and personal money', 'Small business', "One account for the business, one for you. It sounds small, but it saves hours every quarter and makes your numbers easy to read."],
                ['We have moved to a bigger office', 'News', "Same team, more room. From next month we are on the second floor of the Market Building, with parking at the back."],
                ['Meet Priya, our newest bookkeeper', 'News', "Priya joins us after six years helping restaurants keep their books. Say hello when you come in; she makes very good coffee."],
            ],
            'form' => ['template' => 'client_satisfaction_survey_form', 'title' => 'How did we do?'],
            'video' => 'A two-minute tour of how we work',
            'snippet' => ['Office hours in the footer', "add_action('wp_footer', function () {\n    echo '<p class=\"office-hours\">Open Monday to Friday, 9am to 5pm</p>';\n});"],
        ],
        'bookings' => [
            'name' => 'Calm Roots Wellness',
            'tagline' => 'Massage and coaching, booked online',
            'kinds' => ['booking', 'enquiry'],
            'categories' => ['Wellness', 'Coaching', 'News'],
            'posts' => [
                ['What to expect at your first massage', 'Wellness', "Arrive ten minutes early, tell us what hurts, and breathe. We will check in about pressure as we go, and you can stop at any time."],
                ['Three stretches for desk days', 'Wellness', "Neck rolls, a doorway chest stretch and a seated twist. Two minutes, every hour, and your shoulders will thank you."],
                ['Why coaching works best in small steps', 'Coaching', "Big goals stall. Small, weekly steps add up. In our coaching sessions we pick one thing to change before we meet again."],
                ['How to get the most from a coaching call', 'Coaching', "Write down one win and one worry before the call. That is enough to start a useful conversation."],
                ['Saturday mornings are now open', 'News', "By popular request, Maya now takes bookings on Saturday mornings from 10 to 2."],
                ['Gift vouchers are here', 'News', "Give someone an hour of calm. Vouchers work for any service and never expire."],
            ],
            'form' => ['template' => 'client_satisfaction_survey_form', 'title' => 'After your session'],
            'video' => 'A short welcome from the studio',
            'snippet' => ['Booking reminder banner', "add_action('wp_body_open', function () {\n    echo '<p class=\"booking-banner\">New: Saturday mornings now open</p>';\n});"],
        ],
        'online-store' => [
            'name' => 'Thread & Co.',
            'tagline' => 'Everyday clothes, made to last',
            'kinds' => ['order', 'enquiry'],
            'categories' => ['Style', 'Behind the seams', 'News'],
            'posts' => [
                ['How to choose the right hoodie size', 'Style', "Measure a hoodie you already love, flat, armpit to armpit. Then compare it to the size chart on each product page."],
                ['Five ways to wear a classic cap', 'Style', "Forward, back, with a hoodie, with a jacket, or not at all on a bad hair day. We have opinions."],
                ['Where our fleece comes from', 'Behind the seams', "We buy from two mills we have visited ourselves. Here is what we look for and why it costs a little more."],
                ['Packing an order, start to finish', 'Behind the seams', "Every parcel is packed by hand in recycled paper. A peek at a normal Tuesday in the studio."],
                ['Winter collection is live', 'News', "Heavier fleece, two new colours and the return of the zipper hoodie."],
                ['Free shipping weekend', 'News', "Use FREESHIP at checkout until Sunday night."],
            ],
            'form' => ['template' => 'customer_complaint_form', 'title' => 'Return or problem with an order'],
            'video' => 'How we make a hoodie',
            'snippet' => ['Free shipping notice', "add_action('wp_body_open', function () {\n    echo '<p class=\"shipping-notice\">Free shipping over \$75</p>';\n});"],
        ],
        'community' => [
            'name' => 'Makers Circle',
            'tagline' => 'A community for people building a creative business',
            'kinds' => ['space', 'course'],
            'categories' => ['Community', 'Guides', 'News'],
            'posts' => [
                ['Welcome to Makers Circle', 'Community', "We are a group of makers helping each other turn what we make into a living. Introduce yourself in the Welcome space."],
                ['Member story: from market stall to online shop', 'Community', "Omar sold his first wallet at a Sunday market. Two years later he ships every week. Here is how."],
                ['How to price handmade work', 'Guides', "Materials, time, a fair wage and a margin. The formula is simple; sticking to it is the hard part."],
                ['Photographing products on a phone', 'Guides', "Window light, a white card and a steady hand. No studio needed."],
                ['New course: Start your shop in 30 days', 'News', "Nine short lessons that take you from idea to first sale. Members get it free."],
                ['Live Q&A every first Thursday', 'News', "Bring your questions. We will record it for anyone who can't make it."],
            ],
            'form' => ['template' => 'client_satisfaction_survey_form', 'title' => 'Member survey'],
            'video' => 'A welcome from the Makers Circle team',
            'snippet' => ['Member count in the footer', "add_action('wp_footer', function () {\n    echo '<p class=\"members\">Join over 1,000 makers</p>';\n});"],
        ],
        'everything' => [
            'name' => 'Brightline Studio',
            'tagline' => 'Clothes, classes and a community for makers',
            'kinds' => ['order', 'booking', 'space', 'course'],
            'categories' => ['Shop', 'Classes', 'Community'],
            'posts' => [
                ['Our winter collection is here', 'Shop', "Heavier fleece, two new colours and the return of the zipper hoodie."],
                ['Free shipping weekend', 'Shop', "Use FREESHIP at checkout until Sunday night."],
                ['New: book a one-to-one design session', 'Classes', "Bring your idea, leave with a plan. Sessions are 45 minutes, online or in the studio."],
                ['What to bring to your first class', 'Classes', "A notebook, a question and nothing else. We have everything else."],
                ['Member story: from market stall to online shop', 'Community', "Omar sold his first wallet at a Sunday market. Two years later he ships every week."],
                ['Live Q&A every first Thursday', 'Community', "Bring your questions. We will record it for anyone who can't make it."],
            ],
            'form' => ['template' => 'customer_complaint_form', 'title' => 'Return or problem with an order'],
            'video' => 'Inside the studio',
            'snippet' => ['Free shipping notice', "add_action('wp_body_open', function () {\n    echo '<p class=\"shipping-notice\">Free shipping over \$75</p>';\n});"],
        ],
        'highlevel' => [
            'name' => 'Summit Roofing',
            'tagline' => 'Roof repairs and replacements, done right',
            'kinds' => [],
            'categories' => ['Roof care', 'Projects', 'News'],
            'posts' => [
                ['Five signs your roof needs a check', 'Roof care', "Missing shingles, dark patches on the ceiling, granules in the gutter, daylight in the attic and a roof over twenty years old."],
                ['Repair or replace? How we decide', 'Roof care', "If the damage is under a third of the roof and the decking is sound, we repair. Otherwise we talk about replacing."],
                ['Before and after: a 1950s bungalow', 'Projects', "A full tear-off, new decking and architectural shingles in three days."],
                ['Storm season checklist', 'Roof care', "Clear the gutters, trim the trees, and photograph your roof now so you have a before picture."],
                ['We are hiring roofers', 'News', "Full-time roles with training and a company truck. Ask for Owen."],
                ['Free inspections this month', 'News', "Book online and we will send someone within the week."],
            ],
            'video' => 'What happens on install day',
            'snippet' => ['Emergency line in the header', "add_action('wp_body_open', function () {\n    echo '<p class=\"emergency\">Storm damage? Call us any time</p>';\n});"],
        ],
    ];

    $sample = $businesses[$type] ?? $businesses['website'];
    $sample['type'] = $type;
    $sample['business'] = ['name' => $sample['name'], 'tagline' => $sample['tagline']];
    $sample['people'] = $people;

    $sellsProducts = in_array($type, ['online-store', 'everything'], true);
    $takesBookings = in_array($type, ['bookings', 'everything'], true);
    $hasCommunity = in_array($type, ['community', 'everything'], true);

    $sample['shop'] = $sellsProducts ? [
        // FluentCart's sample catalogue: three hoodies in several colours, and ten pieces with one photo each.
        'products' => [['menswear', 3], ['clothing', 10]],
        'categories' => ['Bottoms' => ['jeans', 'shorts', 'leggings'], 'Outerwear' => ['jacket'], 'Accessories' => ['cap'], 'Tops' => ['shirt', 'sweater', 'hoodie', 'sweatshirt', 'dress', 'nightgown']],
        'subscription' => ['Sock club', 'A fresh pair of socks every month, in a colour we pick for you.', 1200],
        'gift' => ['Gift card', 'A gift card for anything in the shop, sent by email.', 5000],
        'coupons' => [['Welcome 10', 'WELCOME10', 'percentage', 10, 'First order'], ['Free shipping', 'FREESHIP', 'fixed', 8, 'Free shipping weekend']],
        // [person index, days ago, [[product index, quantity]], what happened]
        'orders' => [
            [0, 29, [[0, 1]], 'paid'], [1, 27, [[3, 2]], 'paid'], [2, 25, [[5, 1], [3, 1]], 'paid'],
            [3, 22, [[1, 1]], 'refunded'], [4, 20, [[7, 1]], 'paid'], [5, 17, [[2, 1]], 'shipped'],
            [6, 15, [[4, 2]], 'paid'], [7, 12, [[10, 1]], 'paid'], [8, 10, [[6, 1]], 'shipped'],
            [9, 8, [[8, 1], [5, 1]], 'paid'], [10, 6, [[11, 1]], 'paid'], [11, 4, [[9, 1]], 'shipped'],
            [0, 3, [[5, 2]], 'processing'], [12, 2, [[0, 1]], 'processing'], [13, 1, [[3, 1]], 'pending'],
        ],
        'subscribers' => [2, 6, 10],
    ] : [];

    $sample['bookings'] = $takesBookings ? [
        'hosts' => [
            [20, 'Massage therapist with ten years of practice.'],
            [21, 'Coach for small business owners.'],
        ],
        'events' => [
            // [host, title, minutes, price in cents (0 free), location, description]
            [0, 'Free 15-minute consultation', 15, 0, 'phone', 'A short call to talk through what you need.'],
            [0, '60-minute massage', 60, 8000, 'in_person', 'Full-body massage, pressure to suit you.'],
            [1, 'Coaching session', 45, 9500, 'online', 'One focused session on the thing that matters most this month.'],
        ],
        // [event index, person index, days ahead (negative: past), hour UTC, status]
        'bookings' => [
            [1, 2, -9, 14, 'completed'], [2, 3, -6, 16, 'completed'], [0, 4, -3, 10, 'completed'],
            [1, 5, 1, 15, 'scheduled'], [0, 6, 1, 11, 'scheduled'], [2, 7, 2, 17, 'scheduled'],
            [1, 8, 3, 14, 'scheduled'], [2, 9, 4, 16, 'scheduled'], [0, 10, 5, 10, 'scheduled'],
            [1, 11, 6, 15, 'scheduled'], [2, 12, 2, 13, 'cancelled'], [1, 13, 8, 14, 'scheduled'],
        ],
    ] : [];

    $support = [
        'website' => [],
        'bookings' => [
            [3, 'Can I move my Thursday booking?', 'Something came up at work. Is there a slot on Friday instead?', ['Of course. I have moved you to Friday at 3pm and sent a new confirmation.'], 'waiting'],
            [5, 'Do you sell gift vouchers?', "I'd like to buy one for my mum's birthday.", ['Yes! You can buy them on the Services page, and they never expire.'], 'closed'],
            [7, 'Parking question', 'Is there parking near the studio?', [], 'new'],
        ],
        'online-store' => [
            [3, 'Wrong size, can I swap?', 'The hoodie is lovely but a bit small. Can I swap it for a large?', [], 'new'],
            [4, 'Where is my order?', 'I ordered last week and have not had a shipping email yet.', ['Sorry for the wait! It left yesterday; your tracking number is in your account.'], 'waiting'],
            [14, 'Wholesale enquiry', 'I run a small boutique in Phoenix. Do you sell wholesale?', [], 'new'],
            [6, 'Thank you!', 'Just wanted to say the fleece is the best thing I own.', ['That made our day. Thank you for telling us!'], 'closed'],
        ],
    ];
    $support['everything'] = $support['online-store'];
    $sample['tickets'] = $support[$type] ?? [];

    $sample['affiliates'] = $sellsProducts ? [
        // [person index, status, referrals: [order index, status]]
        [15, 'active', [[1, 'paid'], [4, 'unpaid'], [6, 'unpaid']]],
        [16, 'active', [[2, 'unpaid'], [9, 'pending']]],
        [17, 'pending', []],
    ] : [];

    $sample['community'] = $hasCommunity ? [
        'members' => range(0, 11),
        'groups' => [
            ['Start here', [['Welcome', 'Say hello and tell us what brought you here.', 'public'], ['Introductions', 'Who you are and what you make.', 'public']]],
            ['Learn', [['Show your work', 'Share what you are making and get friendly feedback.', 'public'], ['Members only', 'Live Q&A notes, deals and the course chat.', 'private']]],
        ],
        // [author index (0 = the site's admin), space index, message, pinned]
        'feed' => [
            [0, 0, "Welcome, everyone! Introduce yourself below: who you are, what you make, and what you'd like to get from this community.", true],
            [1, 1, "Hi all, I'm Maya. I run a small design studio in Portland and I'm here to learn from people who've been where I am.", false],
            [2, 1, "Daniel here, from Atlanta. Woodworking on weekends, trying to make it more than a hobby.", false],
            [3, 2, "Finished my first big catering order this week. It took longer than planned, but I learned a lot. Happy to share notes.", false],
            [4, 0, "Is anyone else joining the live Q&A on Thursday? I have a few questions saved up about pricing.", false],
            [5, 2, "Here is a before and after of my product photos, shot with a phone and a white card. Feedback very welcome!", false],
            [6, 3, "Notes from last month's Q&A are up. The big one: raise your prices before you think you're ready.", true],
            [7, 1, "Hello from New Orleans! Musician and teacher. I want to sell my lesson plans.", false],
            [8, 2, "Second studio opens next month. Terrified and excited.", false],
            [9, 2, "Question: how do you all handle shipping costs for heavy items?", false],
            [10, 1, "Chloe, baker in San Diego. Sourdough subscriptions are my next project.", false],
            [4, 3, "Just finished lesson 4 of the course. The pricing worksheet alone was worth it.", false],
        ],
        'replies' => ['Great to see this here. Thanks for sharing!', 'This is really helpful, thank you.', 'Welcome! You will love it here.', 'Saving this one for later.', 'Love this. Keep going!'],
        'course' => [
            'title' => 'Start your shop in 30 days',
            'description' => 'Nine short lessons that take you from idea to first sale.',
            'sections' => [
                ['Week 1: Your idea', [['Pick one thing to sell', 'Start with the thing people already ask you for.'], ['Who is it for?', 'Write down three people you know who would buy it.'], ['Price it properly', 'Materials, time, a fair wage and a margin.']]],
                ['Week 2: Your shop', [['Photos that sell', 'Window light, a white card and a steady hand.'], ['Write a product page', 'What it is, who it is for, and why it is worth it.'], ['Set up checkout', 'Payments, shipping and the emails your customers get.']]],
                ['Week 3: Your first sale', [['Tell ten people', 'Your first customers are already in your phone.'], ['Ask for a review', 'A short, friendly email a week after delivery.'], ['What to do next', 'Keep what worked, drop what did not, and plan month two.']]],
            ],
            // [member index, lessons done]
            'students' => [[1, 9], [2, 5], [3, 3], [11, 4], [7, 0]],
        ],
    ] : [];

    return $sample;
};
