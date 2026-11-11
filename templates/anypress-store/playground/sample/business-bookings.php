<?php
/**
 * The Bookings demo: Calm Roots Wellness, a massage and coaching studio. Elena (massage) and Kai (coaching) take
 * bookings, write the blog and send a monthly letter.
 *
 * Posts: [title, category, writer, image, body]. In a body, a blank line starts a paragraph, "## " a heading and
 * "- " a list item.
 */
return [
    'name' => 'Calm Roots Wellness',
    'tagline' => 'Massage and coaching, booked online',
    'kinds' => ['booking', 'enquiry'],
    'writers' => [
        ['Elena', 'Petrova', 'Massage therapist with ten years of practice. Founded Calm Roots in 2019.'],
        ['Kai', 'Nakamura', 'Coach for small business owners. Believes in small steps and long walks.'],
        ['Rosa', 'Lindqvist', 'Runs the front desk, the calendar and this blog. Tea expert.'],
    ],
    'categories' => [
        'Massage' => 'What happens on the table, and how to get the most from it.',
        'Coaching' => 'Notes from Kai on goals, habits and running a small business.',
        'Self care' => 'Small things to do between sessions.',
        'Studio news' => 'New times, new faces and what is coming up.',
    ],
    'posts' => [
        ['What to expect at your first massage', 'Massage', 0, 'massage', "If you have never had a massage, the first one can feel like a lot of unknowns. Here is exactly what happens, start to finish.\n\n## Before\n\nArrive ten minutes early. We will ask about any injuries, what hurts and what you would like to focus on. There is a short form you can fill in online before you come.\n\n## During\n\nYou undress to your comfort level and lie under a sheet. Only the part being worked on is uncovered. I check in about pressure early on, and you can ask me to change it at any time.\n\n## After\n\nDrink some water and take it easy for the rest of the day. A little soreness the next day is normal, like after a good workout."],
        ['Three stretches for desk days', 'Self care', 0, 'stretching', "Most of the tension I see comes from desks. These three take two minutes and you can do them without standing up.\n\n- Neck rolls: slow half-circles, ear to shoulder, five each way\n- Doorway chest stretch: forearms on the frame, lean through gently for thirty seconds\n- Seated twist: hand on the opposite knee, look over your shoulder, breathe\n\nSet a reminder for once an hour. Your shoulders will notice by Friday."],
        ['Why coaching works best in small steps', 'Coaching', 1, 'notebook planning', "Big goals stall. Not because people are lazy, but because a big goal does not tell you what to do on a Tuesday afternoon.\n\nIn our sessions we pick one thing to change before we meet again. Not ten. One. Then we look at what happened, honestly, and pick the next one.\n\nAfter three months, those single steps add up to something that looks a lot like the big goal."],
        ['How to get the most from a coaching call', 'Coaching', 1, 'laptop video call', "Write down one win and one worry before the call. That is enough to start a useful conversation.\n\n## Bring\n\n- The one number you check most in your business\n- Something you have been putting off\n- A question you have been embarrassed to ask\n\nWe will leave with one step, a date, and a way to know if it worked."],
        ['Deep tissue or Swedish? How to choose', 'Massage', 0, 'spa massage', "Swedish massage uses long, flowing strokes and lighter pressure. It is for relaxing and for people who are new to massage.\n\nDeep tissue works slower and firmer on the layers under the surface. It is for stubborn knots, sports recovery and long-term tension.\n\nNot sure? Book a 60-minute massage and tell me what you want to feel like when you leave. I will mix the two."],
        ['Saturday mornings are now open', 'Studio news', 2, 'morning sunlight', "By popular request, Elena now takes bookings on Saturday mornings from 10 to 2. They fill up fast, so book a week or two ahead."],
        ['The power of a ten-minute walk', 'Self care', 1, 'walking path', "When a client tells me they are stuck, I ask when they last went for a walk without their phone.\n\nTen minutes outside resets more than your legs. Most of my best ideas, and most of my clients' best decisions, arrive on a walk. Try it before your next hard decision."],
        ['Massage for runners: before or after a race?', 'Massage', 0, 'runner', "A light massage two or three days before a race loosens you up without leaving you sore. Save deep work for at least four days after.\n\nIf you are training for something, a fortnightly session through the training block catches small problems before they become injuries. Ask about our runner's package at the desk."],
        ['Pricing your services without guilt', 'Coaching', 1, 'coffee desk', "Almost every small business owner I coach is undercharging. The fix is not confidence; it is arithmetic.\n\nAdd up what it costs to run your business for a month, what you need to take home, and how many hours you can really sell. Divide. That is your floor, not your price.\n\nNow look at what the people you admire charge. Your price is somewhere between the two."],
        ['Gift vouchers are here', 'Studio news', 2, 'gift box', "Give someone an hour of calm. Vouchers work for any service, can be sent by email or printed, and never expire. Buy them at the desk or ask us by email."],
        ['Sleep better with a simple evening routine', 'Self care', 0, 'tea', "The body likes rhythm. A routine tells it that the day is ending.\n\n- Screens off thirty minutes before bed\n- A warm shower or bath\n- Five minutes of slow breathing, four counts in, six out\n- The same time every night, weekends too\n\nGive it two weeks before you judge it."],
        ['What I learned from my first year of coaching', 'Coaching', 1, 'journal writing', "A year ago I left my office job to coach full time. Three things surprised me.\n\nPeople rarely need more information. They need someone to ask what they will do next and then ask again in a week. The most useful thing I do is listen without fixing. And the clients who do best are the ones who book the next session before they leave.\n\nThank you to everyone who took a chance on me this year."],
        ['Meet Rosa, the voice on the phone', 'Studio news', 2, 'smiling woman', "If you have called or emailed us this year, you have met Rosa. She keeps the calendar, the tea cupboard and the rest of us in order.\n\nAsk her for the oolong. She has opinions."],
        ['Hot stone massage, explained', 'Massage', 0, 'stones spa', "Smooth basalt stones are heated to about 50°C and used with massage strokes. The heat lets muscles relax faster, so we can work deeper with less pressure.\n\nIt is lovely in winter and for anyone who runs cold. It is not for you if you are pregnant or have circulation problems. Ask us first."],
        ['Setting goals for the new year (that you will keep)', 'Coaching', 1, 'calendar planning', "Skip the resolutions. Pick one area of your life or business and one thing you would like to be true by the end of March.\n\nThen work backwards: what would need to be true by the end of February? By the end of January? This week?\n\nWrite this week's step on a sticky note. That is your whole plan for now."],
        ['How often should you get a massage?', 'Massage', 0, 'relaxing', "For general wellbeing, once a month is a good rhythm. For a specific problem, weekly or fortnightly for a month or two, then monthly to keep it away.\n\nThe best schedule is the one you will keep. Many clients book their next visit before they leave so they do not have to think about it."],
        ['Our new studio room is open', 'Studio news', 2, 'interior room plants', "We have taken over the room next door. It is quieter, warmer and has a window onto the garden. Couples' massages are now possible on Fridays."],
        ['Breathing for busy days', 'Self care', 1, 'meditation', "When the day gets away from you, try box breathing: in for four, hold for four, out for four, hold for four. Four rounds.\n\nIt takes a minute and you can do it in a meeting without anyone noticing. I use it before every coaching call."],
    ],
    'drafts' => [
        ['Five questions to ask before you book a coach', 'Coaching', 1, "Notes: chemistry call, who they have worked with, how they measure progress, cancellation policy, what happens between sessions."],
    ],
    'scheduled' => [
        ['Winter self care: our favourite five', 'Self care', 0, 'winter cozy', "Cold months tighten everything. Our five favourite ways to stay loose: a hot bath with salts, a warm scarf, an evening stretch, a monthly massage and an early night."],
    ],
    'comments' => [
        'This was so reassuring before my first visit, thank you.',
        'I do the neck rolls every afternoon now. Game changer.',
        'Booked my first coaching call after reading this.',
        'Do you do deep tissue for shoulders specifically?',
        'Love the Saturday times!',
        'Bought a voucher for my sister. She loved it.',
        'The breathing trick helped me before a big presentation.',
        'How long is the hot stone session?',
        'Kai helped me finally raise my prices. Thank you.',
        'Rosa is the best!',
    ],
    'replies' => [
        'So glad it helped. See you soon!',
        'Yes, just mention it when you book.',
        'Thank you for the kind words.',
        'Ninety minutes, with time to rest after.',
        'That makes our day.',
    ],
    'messages' => [
        ['Can I book for my partner too?', 'A booking', 'Hi, is it possible to book two massages back to back on a Friday?'],
        ['Insurance receipts', 'A question', 'Do you give receipts I can send to my health insurance?'],
        ['Corporate wellness day', 'Something else', 'We are a team of twelve and would love chair massages at our office for a morning. Is that something you do?'],
        ['Pregnancy massage', 'A question', 'I am 20 weeks pregnant. Is massage safe, and do you offer it?'],
        ['Coaching for a new bakery', 'A booking', 'I am opening a bakery in the spring and would love some coaching on pricing and hiring.'],
        ['Thank you', 'Something else', 'My back has not felt this good in years. Thank you, Elena.'],
        ['Parking', 'A question', 'Is there parking near the studio, or should I take the bus?'],
        ['Gift voucher for Mother\'s Day', 'A question', 'Can you post a printed voucher, or is it email only?'],
    ],
    'newsletter' => [
        'name' => 'Calm Notes',
        'every' => 30,
        'issues' => [
            ['Spring is for stretching', 'Three stretches and new Saturday times', 'Longer days, looser shoulders. This month: three stretches for desk days and our new Saturday mornings.'],
            ['Your first massage, demystified', 'Everything you wanted to ask', 'We get the same five questions from first-timers every week, so we answered them all in one place.'],
            ['Summer plans and small steps', 'A note from Kai', 'Kai on why the smallest goals work best, and a summer offer for coaching clients.'],
            ['Runners, this one is for you', 'Before or after the race?', 'Race season is here. Elena explains when to book a massage and when to stay away.'],
            ['Pricing without guilt', 'The arithmetic of charging enough', 'Our most-read post this year, plus gift vouchers are finally here.'],
            ['A warm room for colder days', 'Hot stones and our new studio room', 'Hot stone massage is back for winter, and our new room is open.'],
        ],
        'next' => ['Winter self care', 'Our five favourite ways to stay loose', 'Five small ways to look after yourself as the nights get longer.'],
        'draft' => ['Holiday gift vouchers', 'The easiest present you will buy', 'Vouchers for every budget, ready by email in minutes. (Draft: add the December opening hours.)'],
        'welcome' => [
            [0, 'Welcome to Calm Roots', 'How booking works', '<p>Hi {{contact.first_name|there}},</p><p>Thank you for joining us. Once a month you will get Calm Notes: one self care idea, studio news and the occasional offer.</p><p>You can book any session online, any time, and change it up to 24 hours before.</p><p>Elena, Kai and Rosa</p>'],
            [2, 'Before your first visit', 'A short form saves time', '<p>Hi {{contact.first_name|there}},</p><p>If you have a visit coming up, fill in our short intake form before you arrive so we can spend the whole hour on you.</p><p>Rosa</p>'],
            [6, 'A small gift', 'Ten percent off your next session', '<p>Hi {{contact.first_name|there}},</p><p>Here is ten percent off your next massage or coaching session. Just mention this email when you book.</p><p>Elena</p>'],
        ],
    ],
    'form' => ['template' => 'client_satisfaction_survey_form', 'title' => 'After your session'],
    // Filled in before a first visit (the welcome email links to it). Entries: [person, days ago, answers].
    'forms' => [[
        'template' => 'patient_intake_form',
        'title' => 'New client intake',
        'page' => '/intake/',
        'keep' => ['names', 'input_text_2', 'input_radio_3', 'input_text_6', 'description'],
        'relabel' => [
            'input_text_2' => ['What do you do for work?', null],
            'input_radio_3' => ['Any injuries, conditions or allergies we should know about?', ['Yes', 'No']],
            'input_text_6' => ['If yes, tell us a little more', null],
            'description' => ['What would you like to focus on?', null],
        ],
        'entries' => [
            [5, 1, ['input_text_2' => 'Trail guide', 'input_radio_3' => 'Yes', 'input_text_6' => 'Sprained left ankle in August, mostly healed.', 'description' => 'Calves and lower back after long runs.']],
            [6, 2, ['input_text_2' => 'Florist', 'input_radio_3' => 'No', 'input_text_6' => '', 'description' => 'Shoulders and neck. I am on my feet all day.']],
            [8, 3, ['input_text_2' => 'Yoga teacher', 'input_radio_3' => 'No', 'input_text_6' => '', 'description' => 'Hips and upper back, deep pressure please.']],
            [10, 4, ['input_text_2' => 'Baker', 'input_radio_3' => 'Yes', 'input_text_6' => 'Mild nut allergy, so no almond oil please.', 'description' => 'Wrists and forearms from kneading.']],
            [12, 6, ['input_text_2' => 'Consultant', 'input_radio_3' => 'No', 'input_text_6' => '', 'description' => 'Coaching: pricing my services and hiring my first person.']],
            [4, 9, ['input_text_2' => 'Bookkeeper and potter', 'input_radio_3' => 'No', 'input_text_6' => '', 'description' => 'Tension headaches, mostly in the afternoons.']],
            [2, 14, ['input_text_2' => 'Caterer', 'input_radio_3' => 'Yes', 'input_text_6' => 'Pregnant, 20 weeks.', 'description' => 'Lower back and feet, gentle pressure.']],
        ],
    ]],
    'video' => 'A short welcome from the studio',
    'snippet' => ['Booking reminder banner', "add_action('wp_body_open', function () {\n    echo '<p class=\"booking-banner\">New: Saturday mornings now open</p>';\n});"],
];
