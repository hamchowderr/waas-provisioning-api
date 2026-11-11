<?php
/**
 * The Community demo: Makers Circle, a paid community and course for people building a creative business. The
 * founders and a member write the blog, and a monthly letter goes to members and everyone thinking of joining.
 *
 * Posts: [title, category, writer, image, body]. In a body, a blank line starts a paragraph, "## " a heading and
 * "- " a list item.
 */
return [
    'name' => 'Makers Circle',
    'tagline' => 'A community for people building a creative business',
    'kinds' => ['space', 'course'],
    'writers' => [
        ['Hazel', 'Costa', 'Founder. Ran a ceramics shop for eight years before starting Makers Circle.'],
        ['Felix', 'Keller', 'Runs the course and the monthly live Q&A. Former product photographer.'],
        ['Omar', 'Haddad', 'Member since day one. Makes leather goods in a garage workshop in Detroit.'],
    ],
    'categories' => [
        'Guides' => 'Practical how-tos for selling what you make.',
        'Member stories' => 'How members built their businesses, in their own words.',
        'Live Q&A notes' => 'The best answers from our monthly calls.',
        'Community news' => 'What is new in the circle.',
    ],
    'posts' => [
        ['Welcome to Makers Circle', 'Community news', 0, 'workshop crafts', "We are a group of makers helping each other turn what we make into a living. Potters, woodworkers, bakers, printers, weavers and more.\n\nInside you will find spaces to share your work, a course that takes you from idea to first sale, and a live Q&A every month. Start by introducing yourself in the Introductions space."],
        ['How to price handmade work', 'Guides', 0, 'pottery', "Most makers price by looking at what others charge. Start with your own numbers instead.\n\n## The formula\n\n- Materials for one piece\n- Your time, at a wage you would accept from an employer\n- A share of your monthly costs (studio, tools, fees)\n- A margin, so the business can grow\n\nAdd them up. That is your price. If it feels too high, the answer is usually to make faster or sell somewhere else, not to work for free."],
        ['Photographing products on a phone', 'Guides', 1, 'phone photography', "You do not need a studio. You need a window, a white card and a steady hand.\n\nPut the product near a window with soft daylight, not direct sun. Hold the card on the other side to bounce light into the shadows. Turn off the flash, tap to focus, and take twenty shots. One will be great.\n\nShoot the same way every time so your shop looks like one brand."],
        ['Member story: from market stall to online shop', 'Member stories', 2, 'leather', "I sold my first wallet at a Sunday market in 2021. It took four hours and I was thrilled.\n\nTwo years later I ship every week. The thing that changed it was the course: pricing properly, photos that look like they belong together, and an email list I actually send to.\n\nIf you are where I was, start your list now. Those first market customers became my best online ones."],
        ['Live Q&A notes: raising your prices', 'Live Q&A notes', 1, 'meeting notes', "The big one from this month's call: raise your prices before you think you are ready.\n\nThree members raised prices by twenty percent last quarter. All three sold the same number of pieces. One sold more.\n\nTell your regulars a month ahead, keep one smaller item at the old price, and do not apologise."],
        ['Building an email list from zero', 'Guides', 0, 'laptop email', "An email list is the only audience you own. Social platforms change the rules; your list does not.\n\nStart with a sign-up form on your site and a clipboard at markets. Offer something small: early access, a discount, or a behind-the-scenes note. Send something every month, even if it is short."],
        ['New course: Start your shop in 30 days', 'Community news', 1, 'laptop', "Nine short lessons that take you from idea to first sale. Each one has a task you can finish in an evening.\n\nIt is free for members. Start any time, at your own pace, and share what you make in the Show your work space."],
        ['Member story: the baker with a waiting list', 'Member stories', 0, 'bread bakery', "Chloe started selling sourdough to neighbours from her porch. Now she has a subscription with a waiting list.\n\nThe secret, she says, is limits: twenty loaves, Fridays only, pre-ordered. Scarcity made it special, and pre-orders meant no waste."],
        ['Live Q&A notes: shipping heavy things', 'Live Q&A notes', 1, 'shipping boxes', "Shipping ceramics and furniture is expensive. The best answers from the call:\n\n- Charge the real cost, and say why\n- Offer local pickup or delivery in your town\n- Use a flat rate for small items and quotes for big ones\n- Double-box anything breakable, with 5 cm of padding all round"],
        ['Five ways to get your first ten customers', 'Guides', 0, 'market stall', "Your first customers are already in your phone. Tell ten people what you make and ask who they know who would want it.\n\nThen: a local market, a shop that sells similar things, a post in a local group, and a friend with an audience. Ten is enough to learn what works."],
        ['Meet Felix, our course lead', 'Community news', 0, 'photographer', "Felix spent ten years photographing products for brands you have heard of. Now he teaches makers to do it themselves, and runs our monthly live Q&A.\n\nBring him your worst product photo. He loves a challenge."],
        ['Writing product descriptions that sell', 'Guides', 1, 'writing desk', "Say what it is, who it is for and why it is worth it. In that order.\n\nThen add the details people ask about: size, materials, care, and how long it takes to arrive. Read it out loud. If it sounds like you talking to a customer at a market, it is right."],
        ['Live Q&A notes: when to quit the day job', 'Live Q&A notes', 0, 'office', "Nobody on the call quit on a feeling. They quit on a number: six months of savings, and three months in a row where the business covered half their bills.\n\nIf you are close, cut your hours first. Part-time is a fine place to be for a year."],
        ['Member story: printing her way to a studio', 'Member stories', 2, 'printing', "Isla began screen printing tea towels in her kitchen. Last month she signed the lease on her first studio.\n\nHer advice: say yes to wholesale early. Ten shops ordering twenty each beats two hundred single orders, and the shops do the selling for you."],
        ['Our community guidelines', 'Community news', 0, 'people community', "Be generous. Share what you know, celebrate other people's wins, and give feedback you would want to hear.\n\nNo selling in the feed, except in the monthly Show and sell thread. Be kind, always."],
        ['How to run a holiday sale without burning out', 'Guides', 1, 'christmas gifts', "Set a last order date and stick to it. Make your bestsellers in batches in October. Limit custom orders. And plan a week off in January now, before the rush starts."],
        ['Member story: from hobby to half the rent', 'Member stories', 2, 'woodworking', "Daniel builds cutting boards on weekends. This year they paid half his rent.\n\nHe credits two things: pricing with the formula from the course, and a stall at the same market every month so people knew where to find him."],
        ['Live Q&A notes: social media in thirty minutes a week', 'Live Q&A notes', 1, 'smartphone social media', "Batch it. On Sunday, take photos of what you made this week, write three short captions, and schedule them. That is enough.\n\nPost where your customers already are. For most makers that is one platform, not five."],
    ],
    'drafts' => [
        ['Pricing commissions and custom work', 'Guides', 0, "Notes from the last call: charge a deposit, add a design fee, limit revisions to two."],
    ],
    'scheduled' => [
        ['Live Q&A notes: planning next year', 'Live Q&A notes', 1, 'planning desk', "This month's call was all about planning. The one-page plan we shared: one goal, three projects, and the numbers you will check every month."],
    ],
    'comments' => [
        'The pricing formula changed everything for me.',
        'Took my product photos by the window this weekend. Night and day!',
        'Omar, this is so inspiring. Thank you for sharing.',
        'Joined last week and already learned so much.',
        'Can we get the slides from the Q&A?',
        'Starting the course tonight!',
        'Saving this for my next market.',
        'The heavy shipping tips were exactly what I needed.',
        'Love this community so much.',
        'Raised my prices by 15%. Nobody blinked.',
    ],
    'replies' => [
        'So happy to hear it!',
        'They are in the Members only space.',
        'Welcome! Say hi in Introductions.',
        'That is a big step. Well done!',
        'Thank you for being here.',
    ],
    'messages' => [
        ['Team membership?', 'A question', 'Is there a way for two of us from the same studio to join on one membership?'],
        ['Course only?', 'A question', 'Can I buy the course without joining the community?'],
        ['Guest speaker', 'Something else', 'I run an Etsy consultancy and would love to speak at one of your live Q&As.'],
        ['Refund question', 'A question', 'I joined yesterday but the timing is not right. Can I pause instead?'],
        ['Scholarship places', 'A question', 'Do you offer any free or discounted places for makers on a low income?'],
        ['Thank you', 'Something else', 'Just made my first online sale. Could not have done it without the course.'],
        ['Partnership with our maker fair', 'Something else', 'We run a maker fair in Austin and would love to offer your members a discounted stall.'],
        ['Login trouble', 'A question', 'I cannot see the Members only space. Is my membership active?'],
    ],
    'newsletter' => [
        'name' => 'Circle Letter',
        'every' => 30,
        'issues' => [
            ['Welcome to the circle', 'What is new this month', 'Fifty new members joined this month. Here is what they are making, and what is coming up.'],
            ['Your prices are too low', 'Notes from the live Q&A', 'The most-shared moment from this month\'s call, plus a member who doubled her wholesale orders.'],
            ['The course is live', 'Start your shop in 30 days', 'Nine short lessons, free for members. Here is how to get started this week.'],
            ['From market stall to online shop', 'A member story', 'Omar tells the story of his first wallet and his first thousand sales.'],
            ['Shipping heavy things', 'The best answers from our call', 'How members ship ceramics, furniture and everything breakable without losing money.'],
            ['Getting ready for the holidays', 'Without burning out', 'A plan for the busiest season, made by makers who have survived it.'],
        ],
        'next' => ['Planning next year on one page', 'This month\'s live Q&A', 'A one-page plan for next year, and the date of our December call.'],
        'draft' => ['Member spotlight: Isla Murphy', 'From kitchen to studio', 'Isla on wholesale, tea towels and signing her first lease. (Draft: add photos from Isla.)'],
        'welcome' => [
            [0, 'Welcome to Makers Circle', 'Three things to do first', '<p>Hi {{contact.first_name|there}},</p><p>Welcome! Three things to do this week: introduce yourself, start lesson one of the course, and put the next live Q&A in your calendar.</p><p>Hazel</p>'],
            [2, 'Share your work', 'The friendliest feedback on the internet', '<p>Hi {{contact.first_name|there}},</p><p>Post a photo of something you made in Show your work. Members give kind, useful feedback, and it is the fastest way to get to know people here.</p><p>Felix</p>'],
            [6, 'Your first week', 'How is it going?', '<p>Hi {{contact.first_name|there}},</p><p>You have been with us a week. Reply and tell me what you are working on. I read every one.</p><p>Hazel</p>'],
        ],
    ],
    'form' => ['template' => 'client_satisfaction_survey_form', 'title' => 'Member survey'],
    'video' => 'A welcome from the Makers Circle team',
    'snippet' => ['Member count in the footer', "add_action('wp_footer', function () {\n    echo '<p class=\"members\">Join over 1,000 makers</p>';\n});"],
    // What the community sells on its own site (FluentCart): memberships and the course, nothing to ship.
    'sells' => [
        // [title, about, price in cents, how often it bills (once, month or year), photo, category]
        'items' => [
            ['Course: Start your shop in 30 days', 'Nine short lessons from idea to first sale, with a task for each evening. Yours to keep.', 14900, 'once', 'community/06.webp', 'Courses'],
            ['Live Q&A replays', 'Every live Q&A so far, with notes, to watch at your own pace.', 4900, 'once', 'community/04.webp', 'Courses'],
            ['Membership (monthly)', 'The feed, the spaces, the monthly live Q&A and the course. First month free.', 2900, 'month', 'community/14.webp', 'Memberships'],
            ['Membership (yearly)', 'Everything in the monthly membership, two months free.', 29000, 'year', 'community/00.webp', 'Memberships'],
        ],
        'buyers' => [0, 3, 5, 9, 12, 14, 1, 16, 7, 10, 18, 2, 11, 22, 4, 13, 6, 19, 23, 8],
        'subscribers' => [0, 1, 2, 3, 6, 9, 10, 14, 16, 18],
        'coupons' => [['Black Friday', 'MAKERS20', 'percentage', 20, 'Course sale'], ['Friend of a member', 'FRIEND10', 'percentage', 10, 'Member referrals']],
    ],
    // The public pages: [section title, items] and buttons as [label, page slug, '#anchor' or 'portal'].
    'pages' => [
        'products' => 'Join, or start with the course',
        'hero' => 'A community for people building a creative business. Learn to price, photograph and sell what you make, with makers who have done it.',
        'buttons' => [['Join the community', 'portal'], ['About us', 'about']],
        'features' => ['What members get', [
            ['Start your shop in 30 days', 'Nine short lessons from idea to first sale, each with a task you can finish in an evening.'],
            ['A friendly feed', 'Share your work, ask questions and get kind, useful feedback from over a thousand makers.'],
            ['Live Q&A every month', 'Bring your questions to Hazel and Felix. Notes and recordings for members who miss it.'],
        ]],
        'blog' => ['Blog', 'Guides and member stories'],
        'signup' => ['Circle Letter', 'One letter a month: the best of the live Q&A, a member story and what is coming up.'],
        'faq' => ['Before you join', [
            ['How much is membership?', 'One monthly price includes the course, the community and the live calls. The first month is free.'],
            ['Is it for beginners?', 'Yes. About half our members have not made a sale yet.'],
            ['Can I cancel?', 'Any time, from your account, in two clicks.'],
        ]],
        'cta' => ['Come and make with us', 'Your first month is free. Introduce yourself and start lesson one today.', [['Join the community', 'portal']]],
        'about' => ['The story of Makers Circle', [
            'Hazel ran a ceramics shop for eight years and kept answering the same questions from makers starting out: how do I price this, how do I photograph it, where do I sell it?',
            'In 2022 she started Makers Circle to answer them in one place, with Felix running the course and the monthly live Q&A. Today it is over a thousand potters, woodworkers, bakers, printers and weavers helping each other.',
        ], [
            ['Generous', 'Share what you know. Someone shared it with you.'],
            ['Practical', 'Numbers, photos and steps you can do this week.'],
            ['Kind', 'Feedback you would be glad to receive.'],
        ]],
        'contact' => [['Email', 'hello@makerscircle.example'], ['Members', 'Ask in the community and Hazel or Felix will answer.'], ['Live Q&A', 'The first Thursday of every month, online.']],
    ],
];
