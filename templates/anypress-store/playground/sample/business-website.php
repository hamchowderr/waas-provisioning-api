<?php
/**
 * The Website demo: Weeknight Table, a food blog run as a business. Three writers, a fortnightly newsletter, and
 * money from sponsors who write in through the "Work with us" form.
 *
 * Posts: [title, category, writer, image, body]. In a body, a blank line starts a paragraph, "## " a heading and
 * "- " a list item.
 */
return [
    'name' => 'Weeknight Table',
    'tagline' => 'Real dinners for busy weeknights',
    'kinds' => ['enquiry'],
    'writers' => [
        ['Nora', 'Hale', 'Founder and recipe developer. Cooks for a family of four and tests every recipe at least three times.'],
        ['Sam', 'Ortiz', 'Contributing writer. Meal prep, budgets and anything that saves a Tuesday.'],
        ['Jules', 'Park', 'Editor and photographer. Makes the food look as good as it tastes.'],
    ],
    'categories' => [
        'Weeknight dinners' => 'Thirty minutes or less, one pan where we can, and no ingredients you have to hunt for.',
        'Meal prep' => 'An hour on Sunday that makes the week easier.',
        'Baking' => 'Bread, cakes and the occasional disaster, explained.',
        'Kitchen notes' => 'Tools, techniques and the odd review. Sponsored posts are always marked.',
        'From the blog' => 'News, behind the scenes and what is coming next.',
    ],
    'posts' => [
        ['One-pan lemon chicken with crispy potatoes', 'Weeknight dinners', 0, 'chicken dinner', "This is the dinner we make when nobody has the energy to think. Everything goes in one pan, the oven does the work, and the potatoes come out crisp at the edges and soft in the middle.\n\n## What you need\n\n- 6 chicken thighs, skin on\n- 600 g small potatoes, halved\n- 1 lemon, sliced thin\n- 4 cloves of garlic, smashed\n- Olive oil, salt and a big pinch of dried oregano\n\n## How to make it\n\nHeat the oven to 220°C. Toss the potatoes with oil and salt and spread them in a big tray. Nestle the chicken in between, skin side up, and tuck the lemon and garlic around it.\n\nRoast for 40 minutes, until the skin is golden and the potatoes are crisp. Squeeze the roasted lemon over everything before you serve.\n\nIf you only have breasts, add them after 15 minutes so they stay juicy."],
        ['How I plan a week of dinners in 20 minutes', 'Meal prep', 1, 'planner notebook', "Planning dinners used to take me an hour and still fall apart by Wednesday. Now it takes twenty minutes on a Sunday, and it holds.\n\n## The rules\n\n- Two new recipes a week, five you already know\n- One night of leftovers, on purpose\n- One night that is just eggs on toast, and that is fine\n\n## The list\n\nI write the plan on the fridge and the shopping list straight from it, sorted by where things are in the shop. It sounds fussy. It saves me fifteen minutes in the aisles every week.\n\nThe free planner from our newsletter has the same layout, if you want to try it."],
        ['The no-knead loaf that got me baking again', 'Baking', 0, 'bread loaf', "I stopped baking bread for years because it felt like a weekend project. This loaf changed that: five minutes of stirring at night, and a crackly loaf by lunch.\n\n## What you need\n\n- 500 g bread flour\n- 10 g salt\n- 2 g dried yeast\n- 400 ml lukewarm water\n\n## How to make it\n\nStir everything together until there is no dry flour. Cover the bowl and leave it on the counter overnight, 12 to 18 hours.\n\nIn the morning, tip it onto a floured counter, fold it over itself a few times and let it rest while a lidded pot heats in a 240°C oven. Bake 30 minutes with the lid on and 15 with it off.\n\nLet it cool for an hour. I know. It is worth it."],
        ['Sheet-pan gnocchi with peppers and feta', 'Weeknight dinners', 1, 'pasta vegetables', "Shop-bought gnocchi roasts beautifully. No boiling, no draining, just a hot oven and a tray.\n\nToss a pack of gnocchi with sliced peppers, a red onion, olive oil and salt. Roast at 220°C for 20 minutes, give it a shake, crumble feta over the top and roast 5 more.\n\nFinish with a handful of basil and a squeeze of lemon. It serves three, or two very hungry people."],
        ['Five pantry staples that save dinner', 'Kitchen notes', 2, 'jars', "When the fridge is empty, these five things turn into a real meal.\n\n- Tinned tomatoes: sauce, soup or shakshuka\n- Chickpeas: roast them, mash them, curry them\n- Dried pasta: the obvious hero\n- Eggs: the most useful thing in your kitchen\n- A good stock cube: makes everything taste like you tried\n\nKeep two of each and you are never more than fifteen minutes from dinner."],
        ['Sunday prep: three bases, ten dinners', 'Meal prep', 1, 'lunch', "Instead of cooking whole meals on Sunday, I cook three bases that turn into different dinners all week.\n\n## The bases\n\n- A big pot of tomato sauce\n- A tray of roasted vegetables\n- A pot of rice or grains\n\n## What they become\n\nThe sauce becomes pasta on Monday and shakshuka on Thursday. The vegetables go into a frittata, a grain bowl and a soup. The rice turns into fried rice by Friday, which is when it is best anyway.\n\nThe whole prep takes about an hour and a half, and the kitchen is only messy once."],
        ['Sponsored: the knife we actually use every day', 'Kitchen notes', 2, 'kitchen knife cutting board', "This post is sponsored by Edgewise Knives. We only work with brands we would buy from ourselves, and we said yes to this one because we already owned the knife.\n\nA good chef's knife is the one tool that changes how cooking feels. Ours has a 20 cm blade, a handle that does not slip and an edge that has lasted two years of daily use with a sharpen every few months.\n\nIf you are buying one, hold it first. It should feel balanced at the point where the blade meets the handle. That matters more than the brand."],
        ['Brown butter chocolate chip cookies', 'Baking', 0, 'chocolate chip cookies', "Brown the butter. That is the whole secret. It takes five minutes and makes the cookies taste of toffee.\n\n## What you need\n\n- 170 g butter\n- 200 g brown sugar and 50 g white sugar\n- 1 egg and 1 yolk\n- 250 g flour, 1 tsp baking soda, 1 tsp salt\n- 200 g dark chocolate, chopped\n\n## How to make it\n\nMelt the butter and keep cooking until it smells nutty and the bits at the bottom turn brown. Let it cool for ten minutes, then whisk in the sugars and eggs. Fold in the dry ingredients and the chocolate.\n\nChill the dough for at least an hour, then bake balls of it at 180°C for 11 minutes. Take them out while the middles still look soft."],
        ['Fifteen-minute peanut noodles', 'Weeknight dinners', 1, 'noodles', "The sauce is pantry only: peanut butter, soy sauce, a little honey, lime and hot water to loosen it. Whisk it while the noodles cook.\n\nToss the drained noodles with the sauce, sliced cucumber and spring onions. Add leftover chicken or tofu if you have it.\n\nIt is good hot, and better cold from the fridge the next day."],
        ['How we test a recipe before it goes live', 'From the blog', 0, 'kitchen cooking', "Every recipe on Weeknight Table is cooked at least three times before you see it. Once by me, once by Sam in a different kitchen, and once by a reader from our testing group.\n\nThe reader test matters most. They cook it on a real weeknight, with real interruptions, and tell us where they got stuck. Half our recipes change after that test.\n\nWant to join the testing group? Reply to any newsletter and say so."],
        ['Freezer-friendly chili for busy weeks', 'Meal prep', 1, 'stew', "Make a double batch on Sunday, eat half, freeze the rest in flat bags so they thaw in twenty minutes.\n\nThe base is onions, garlic, beef or lentils, two tins of tomatoes, two tins of beans and a spoon each of cumin, paprika and chili. Let it bubble for forty minutes.\n\nTop it with yoghurt, coriander and something crunchy. Tortilla chips count."],
        ['Our camera and lighting setup, for food bloggers', 'Kitchen notes', 2, 'camera photography food', "We get asked about our photos every week, so here is the honest answer: one camera, one window and a piece of white card.\n\nWe shoot near a north-facing window in the late morning, with the card opposite the window to fill in the shadows. A tripod helps more than a new lens.\n\nIf you are starting a food blog, start with your phone and the window. Upgrade when the light is the only thing holding you back."],
        ['Banana bread, the reader favourite', 'Baking', 0, 'baking', "This is the most-made recipe on the blog, and the one readers write to us about the most.\n\nMash three very ripe bananas. Stir in 75 g melted butter, 150 g sugar, an egg and a teaspoon of vanilla. Fold in 190 g flour, a teaspoon of baking soda and a pinch of salt.\n\nBake in a lined loaf tin at 175°C for about an hour. It keeps for three days, if it lasts that long."],
        ['A week of dinners for under fifty dollars', 'Meal prep', 1, 'vegetables', "Food prices are up, so we set ourselves a challenge: five dinners for a family of four, under fifty dollars.\n\nWe managed it with a chicken roasted on Monday and stretched into Tuesday's soup, a pot of dal, pasta with sausage and greens, and a big tray of baked potatoes with toppings.\n\nThe full shopping list is in this week's newsletter. The secret is the whole chicken."],
        ['Crispy salmon with garlicky greens', 'Weeknight dinners', 0, 'salmon dinner plate', "Pat the salmon dry, salt it, and put it skin down in a hot pan. Leave it alone for six minutes. The skin will let go when it is ready.\n\nFlip it for one minute, then move it to a plate. In the same pan, soften sliced garlic and wilt a big bunch of greens with a splash of water.\n\nServe with rice and a wedge of lemon. Dinner in fifteen minutes."],
        ['We are writing a cookbook', 'From the blog', 0, 'writing notebook', "After four years and more than three hundred recipes, Weeknight Table is becoming a book. Sixty dinners, all tested by our reader group, all ready in thirty minutes.\n\nNewsletter readers will hear everything first: the cover, the recipes that made it, and a chance to get a signed copy.\n\nThank you for cooking with us. None of this happens without you."],
        ['Roasted tomato soup with grilled cheese', 'Weeknight dinners', 1, 'soup', "Roasting the tomatoes first makes this taste like it took all day. It takes forty minutes, most of it in the oven.\n\nHalve a kilo of tomatoes, add an onion and a head of garlic, drizzle with oil and roast at 200°C for 30 minutes. Blend with a cup of stock until smooth.\n\nMake the grilled cheese while the soup blends. Dunking is required."],
        ['Sponsored: what we learned using a meal kit for a month', 'Kitchen notes', 1, 'cooking ingredients table', "This post is sponsored by Greenbox Kitchen, who sent us four weeks of their meal kits. Our opinions are our own.\n\nThe good: no planning, no waste, and our kids tried three vegetables they swore they hated. The less good: the packaging, and recipes that assumed more counter space than we have.\n\nWould we keep it? For the busiest weeks, yes. For every week, we still prefer our own Sunday prep."],
    ],
    // Not published yet: one draft and one scheduled for next week.
    'drafts' => [
        ['Ten-minute breakfast burritos for the freezer', 'Meal prep', 1, "Scramble a dozen eggs with peppers and cheese, roll them in tortillas, wrap each in foil and freeze. Notes still to add: reheating times for the microwave and the oven."],
    ],
    'scheduled' => [
        ['Maple roasted squash with farro', 'Weeknight dinners', 0, 'squash autumn', "Cube a squash, toss it with maple syrup, oil and chili flakes, and roast until the edges catch. Stir it through cooked farro with spinach, toasted seeds and a lemony dressing.\n\nIt is just as good cold, so make extra for lunch."],
    ],
    'comments' => [
        'Made this last night and my kids asked for seconds. That never happens.',
        'Could I use chicken breasts instead of thighs?',
        'Saved this for Sunday. Thank you for the shopping list!',
        'The tip about chilling the dough made all the difference.',
        'Tried it with sweet potatoes. Delicious.',
        'How long does it keep in the fridge?',
        'This is now on our weekly rotation.',
        'Loved the step-by-step photos.',
        'I halved it for two and it worked perfectly.',
        'Finally a recipe that is actually 30 minutes.',
    ],
    'replies' => [
        'So glad to hear it!',
        'Yes, just add them a bit later so they stay juicy.',
        'Thank you for cooking along with us.',
        'Up to three days in a sealed box.',
        'Love that idea, we will try it.',
    ],
    // Messages on the contact form: [subject, interest, message].
    'messages' => [
        ['Sponsorship for our spring range', 'Something else', 'Hi Nora, we make cast iron pans and would love to talk about a sponsored recipe series in March. Do you have a media kit?'],
        ['Recipe question', 'A question', 'Can the lemon chicken be made the night before and reheated?'],
        ['Guest post idea', 'Something else', 'I write about cooking on a budget and would love to pitch a guest post about frozen vegetables.'],
        ['Cookbook pre-order?', 'A question', 'Will there be a way to pre-order the cookbook? I would like two copies.'],
        ['Partnership with our grocery app', 'Something else', 'We run a grocery list app and think your meal plans would be a great fit. Could we set up a call?'],
        ['Thank you', 'Something else', 'Your banana bread got me through a tough month. Just wanted to say thanks.'],
        ['Allergy-friendly versions?', 'A question', 'Do you have any of the weeknight dinners without nuts? My son is allergic.'],
        ['Podcast interview', 'Something else', 'We host a small food podcast and would love to have you on to talk about recipe testing.'],
    ],
    'newsletter' => [
        'name' => 'The Weeknight Letter',
        // Fortnightly. [subject, preheader, intro]; the posts out since the last issue are added below the intro.
        'every' => 14,
        'issues' => [
            ['Soup season is here', 'Plus the planner everyone asked for', 'The evenings are drawing in and our oven is on every night. This fortnight: two soups, a planner and a tip for crispier potatoes.'],
            ['The cookie recipe we keep making', 'Brown butter changes everything', 'We made the brown butter cookies four times in two weeks. For testing. Obviously.'],
            ['Fifteen-minute dinners, ranked', 'Our fastest five', 'Readers voted, and the peanut noodles won by a mile. Here are the rest of the top five.'],
            ['How we test a recipe', 'And how you can help', 'A peek behind the scenes at our recipe testing, and an invitation to join the reader group.'],
            ['Your freezer is your friend', 'Chili, burritos and a thawing trick', 'Two batches on Sunday, ten easy dinners later. Here is how we fill the freezer.'],
            ['A quick note from Nora', 'Something we have been working on', 'We have news, and newsletter readers are hearing it first.'],
            ['Dinner for under fifty dollars', 'The full shopping list inside', 'Food prices are up, so we tried feeding four for a week on fifty dollars. It worked. The list is below.'],
            ['Brought to you by Edgewise Knives', 'The one tool that changes cooking', 'This issue is supported by Edgewise Knives. Plus: our three favourite things to make with a sharp knife and twenty minutes.'],
            ['Baking weekend', 'Bread you can make on a weeknight', 'The no-knead loaf is back by popular demand, with a few new ideas for what to do with it.'],
            ['The cookbook has a cover', 'Come and see it first', 'It is real. It has a cover. And you get to see it before anyone else.'],
            ['Salmon, soup and a slow Sunday', 'This fortnight on the blog', 'Two new dinners, one comforting soup and a gentle reminder to take Sunday off.'],
            ['What we learned from a month of meal kits', 'An honest review', 'We tried a meal kit for a month so you do not have to. Here is what we really thought.'],
        ],
        'next' => ['Squash season starts now', 'A cosy dinner for the colder nights', 'Our favourite autumn dinner goes live next week, and you get it first.'],
        'draft' => ['Gift guide for the cook in your life', 'Things we actually use', 'Ten gifts under fifty dollars, all of them things we use every week. (Draft: add links and photos.)'],
        'welcome' => [
            [0, 'Welcome to the Weeknight Letter', 'Here is what to expect', '<p>Hi {{contact.first_name|there}},</p><p>Thank you for joining! Every other Thursday you will get one email with our newest dinners, one tip that saves time, and the occasional story from our kitchen.</p><p>To start you off, here are our three most-made recipes: the one-pan lemon chicken, the no-knead loaf and the banana bread.</p><p>Nora, Sam and Jules</p>'],
            [3, 'The planner we use every Sunday', 'Twenty minutes to a planned week', '<p>Hi {{contact.first_name|there}},</p><p>The thing readers thank us for most is the weekly planner. Print it, stick it on the fridge, and fill it in on Sunday with two new recipes and five you know.</p><p>Reply and tell us what you are cooking this week. We read every one.</p><p>Sam</p>'],
            [7, 'One question for you', 'Help us write for you', '<p>Hi {{contact.first_name|there}},</p><p>What is the hardest night of the week to get dinner on the table? Hit reply and tell us. The answers shape what we test next.</p><p>Nora</p>'],
        ],
    ],
    // Sponsors and brands write in here; the "Work with us" page links to it. Entries: [person, days ago, answers].
    'form' => [
        'template' => 'sponsor_request_form',
        'title' => 'Work with us',
        'page' => '/work-with-us/',
        'keep' => ['names', 'email', 'input_text', 'dropdown', 'description'],
        'relabel' => [
            'names' => ['Your name', null],
            'email' => ['Email', null],
            'input_text' => ['Company or brand', null],
            'dropdown' => ['What would you like to do?', ['Sponsored recipe', 'Newsletter sponsorship', 'Product review', 'Something else']],
            'description' => ['Tell us about your idea and your budget', null],
        ],
        'entries' => [
            [12, 2, ['input_text' => 'Hearth & Iron', 'dropdown' => 'Sponsored recipe', 'description' => 'Three recipes using our new enamel casserole dish for our spring launch. Budget around $2,400.']],
            [0, 6, ['input_text' => 'Chen Studio', 'dropdown' => 'Newsletter sponsorship', 'description' => 'We design kitchen prints and would like the sponsor slot in two December issues.']],
            [22, 11, ['input_text' => 'Ali Events', 'dropdown' => 'Something else', 'description' => 'Would Nora host a cooking demo at our autumn market? Paid, with travel covered.']],
            [10, 19, ['input_text' => 'Seaside Bakes', 'dropdown' => 'Product review', 'description' => 'We would love to send our sourdough starter kit for an honest review.']],
            [2, 34, ['input_text' => 'Ramirez Catering', 'dropdown' => 'Sponsored recipe', 'description' => 'A holiday menu series, four posts and an Instagram reel. Flexible on budget.']],
            [14, 52, ['input_text' => 'Desert Bloom', 'dropdown' => 'Newsletter sponsorship', 'description' => 'Candle brand, our customers love cooking. One issue in March to start.']],
        ],
    ],
    'video' => 'A weeknight dinner in 30 minutes',
    'snippet' => ['Recipe card print button', "add_filter('the_content', function (\$content) {\n    return is_single() ? \$content . '<p><a href=\"javascript:window.print()\">Print this recipe</a></p>' : \$content;\n});"],
    // The public pages: [section title, items] and buttons as [label, page slug, '#anchor' or 'portal'].
    'pages' => [
        'hero' => 'Real dinners for busy weeknights. Tested recipes that take thirty minutes or less, from a family kitchen in Portland.',
        'buttons' => [['Get the recipes', 'blog'], ['Join the newsletter', '#newsletter']],
        'features' => ['Why people cook with us', [
            ['Thirty minutes, honestly', 'Every recipe is timed in a real kitchen, washing up included, by someone with kids asking what is for dinner.'],
            ['Tested three times', 'Nora cooks each recipe at least three times before it goes up, and changes it when readers tell us something did not work.'],
            ['Shopping lists that make sense', 'Ingredients you can find in any supermarket, with swaps for what you already have.'],
        ]],
        'blog' => ['Recipes', 'New on the blog'],
        'signup' => ['The Weeknight Letter', 'Five dinners, one shopping list, every other Sunday. Free, and you can leave any time.'],
        'faq' => ['Questions readers ask', [
            ['Can I freeze these meals?', 'Most of them, yes. Each recipe says how long it keeps in the fridge and whether it freezes.'],
            ['Do you take sponsored posts?', 'A few a year, only for things we already use. Sponsored posts are always marked at the top.'],
            ['Can I share a recipe?', 'Please do. Link to the recipe rather than copying it, and add a photo of yours.'],
        ]],
        'cta' => ['Work with Weeknight Table', 'Sponsored recipes, newsletter sponsorships and honest product reviews for brands home cooks trust.', [['Work with us', 'work-with-us']]],
        'about' => ['How Weeknight Table started', [
            'Nora started Weeknight Table in 2021, with a notebook of dinners that got her family through a year of long workdays. Friends kept asking for the recipes, so she put them online.',
            'Today Sam and Jules write and photograph with her, the newsletter goes to thousands of home cooks every other Sunday, and every recipe is still cooked in Nora\'s own kitchen first.',
            'The blog is free to read. It is paid for by the newsletter\'s sponsors and a few clearly marked sponsored posts a year.',
        ], [
            ['Tested, not styled', 'Photos show the food as it comes out of the pan, not propped up for the camera.'],
            ['Honest about sponsors', 'We only work with brands we already buy, and we say so every time.'],
            ['Reader first', 'Every comment and email gets read, and the best fixes go back into the recipes.'],
        ]],
        'contact' => [['Email', 'hello@weeknighttable.example'], ['Brand partnerships', 'Use the Work with us form and we answer within two working days.'], ['Where we cook', 'A family kitchen in Portland, Oregon.']],
        'services' => ['Work with us', 'work-with-us', 'Ways to reach home cooks who make dinner every night of the week.', [
            ['Sponsored recipe', 'A recipe developed around your product, photographed by Jules and shared with the newsletter. From $1,200.'],
            ['Newsletter sponsorship', 'A short, clearly marked note at the top of The Weeknight Letter. From $400 an issue.'],
            ['Product review', 'An honest review after a month of real use. We say what we did not like too.'],
        ]],
    ],
];
