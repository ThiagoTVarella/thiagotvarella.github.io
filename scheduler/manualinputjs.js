function parseNames() {
    var students = document.getElementById("students").value;
    // variable that contains the names mentioned
    var studentsArray = students.split(",");
    // variable that contains the number of students mentioned
    var numberOfStudents = studentsArray.length;

    // do the same thing as above but for professors
    var professors = document.getElementById("professors").value;
    var professorsArray = professors.split(",");
    var numberOfProfessors = professorsArray.length;

    // create a variable for the number of timeslots
    var timeslots = document.getElementById("timeslots").value;

    // create a matrix of 0s with the number of students as rows and the number of professors as columns
    var matrixPref = [];
    for (var i = 0; i < numberOfStudents; i++) {
      matrixPref[i] = [];
      for (var j = 0; j < numberOfProfessors; j++) {
        matrixPref[i][j] = 99;
      }
    }

    // prints the number of students mentioned
    document.getElementById("details").innerHTML += "<br>Number of students: " + numberOfStudents +"<br>";

    // // create a div element to hold the text fields
    // var div = document.createElement("div");
    // document.body.appendChild(div);
    
    var div = document.getElementById("details");
    div.appendChild(document.createElement("br")); // add a line break

    // for each student, create a text field and a label
    for (var i = 0; i < numberOfStudents; i++) {
      var label = document.createElement("label");
      label.textContent = "Enter preferences for " + studentsArray[i] + " separated by commas";
      var input = document.createElement("input");
      input.type = "text";
      input.id = "input" + i; // give each input a unique id
      div.appendChild(label);
      div.appendChild(document.createElement("br")); // add a line break after the label
      div.appendChild(input);
      div.appendChild(document.createElement("br")); // add a line break after the input
    }

    // after a line break, for each professor, create a text field and a label asking for the times they are available
    document.getElementById("details").innerHTML += "<br>Number of professors: " + numberOfProfessors +"<br>";
    div.appendChild(document.createElement("br")); // add a line break
    for (var i = 0; i < numberOfProfessors; i++) {
      var label = document.createElement("label");
      label.textContent = "Enter times available for " + professorsArray[i] + " separated by commas";
      var input = document.createElement("input");
      input.type = "text";
      input.id = "inputP" + i; // give each input a unique id
      div.appendChild(label);
      div.appendChild(document.createElement("br")); // add a line break after the label
      div.appendChild(input);
      div.appendChild(document.createElement("br")); // add a line break after the input
    }


    // create a button element that is an input, type button
    var button = document.createElement("input");
    button.type = "button";
    button.value = "Submit";
    div.appendChild(button);


    // after the user has entered the preferences, get the values of the text fields and edit the matrix accordingly
    function getPreferences() {
      for (var i = 0; i < numberOfStudents; i++) {
        var preferences = document.getElementById("input" + i).value; // get the value of the input by id
        var preferencesArray = preferences.split(",");
        for (var j = 0; j < preferencesArray.length; j++) {
          for (var k = 0; k < numberOfProfessors; k++) {
            if (preferencesArray[j] == professorsArray[k]) {
              matrixPref[i][k] = j + 1; // assign the order of preference instead of 1
            }
          }
        }
      }
    }

    // when the button is clicked, get the preferences and print the matrix
    button.addEventListener("click", function() {
      getPreferences();
      // // DEBUG 1 - MATRIX OF PREFERENCES
      // document.getElementById("result").innerHTML += "<br>Matrix of preferences: <br>";
      // for (var i = 0; i < numberOfStudents; i++) {
      //   for (var j = 0; j < numberOfProfessors; j++) {
      //     document.getElementById("result").innerHTML += matrixPref[i][j] + " ";
      //   }
      //   document.getElementById("result").innerHTML += "<br>";
      // }
    });

    // create a matrix of 0s with the number of professors as rows and the number of timeslots as columns
    var matrixAvail = [];
    for (var i = 0; i < numberOfProfessors; i++) {
      matrixAvail[i] = [];
      for (var j = 0; j < timeslots; j++) {
        matrixAvail[i][j] = 0;
      }
    }

    // after the user has entered the times available, get the values of the text fields and assign 1 to the timeslots in which a professor is available
    function getAvailability() {
      for (var i = 0; i < numberOfProfessors; i++) {
        var availability = document.getElementById("inputP" + i).value; // get the value of the input by id
        var availabilityArray = availability.split(",");
        for (var j = 0; j < availabilityArray.length; j++) {
          matrixAvail[i][Number(availabilityArray[j]) - 1] = 1;
        }
      }
    }

    button.addEventListener("click", function() {
      getAvailability();
    // // DEBUG 2 - MATRIX OF AVAILABILITY
    // // print the matrix of availability
    //   document.getElementById("result").innerHTML += "<br>Matrix of availability: <br>";
    //   for (var i = 0; i < numberOfProfessors; i++) {
    //     for (var j = 0; j < timeslots; j++) {
    //       document.getElementById("result").innerHTML += matrixAvail[i][j] + " ";
    //     }
    //     document.getElementById("result").innerHTML += "<br>";
      // }
    });

    // test many possible schedules and print the best one
    // meetings can happen at the same time, but a professor can only meet with one student at a time
    // include the timeslot of the meetings when printing the best schedule. code well commented
    button.addEventListener("click", function() {
      var bestSchedule = [];
      var bestScore = 99*numberOfStudents;

      var matrixAvailCopy = [];
      for (var k = 0; k < numberOfProfessors; k++) {
        matrixAvailCopy[k] = matrixAvail[k].slice();
      }


      for (var i = 0; i < 100; i++) {
        var schedule = [];
        var score = 0;
        // for each student, pick a random professor and a random timeslot
        // restore the availability using the copy
        for (var k = 0; k < numberOfProfessors; k++) {
          matrixAvail[k] = matrixAvailCopy[k].slice();
        }

        for (var j = 0; j < numberOfStudents; j++) {
          var professor = Math.floor(Math.random() * numberOfProfessors); // pick a random professor
          var timeslot = Math.floor(Math.random() * timeslots); // pick a random timeslot
          // if the professor is available at the timeslot, add the meeting to the schedule and add the score
          if (matrixAvail[professor][timeslot] == 1) {
            schedule.push([professor, timeslot]);
            score += matrixPref[j][professor];
            // make the professor unavailable at the timeslot for the copy
            matrixAvail[professor][timeslot] = 0;
          }
          // if the professor is not available at the timeslot, check if it is available at a different timeslot and schedule it
          // if not timeslot is available, add 999 to the score and add an empty meeting at timeslot 0 to the schedule
          else {
            var timeslotAvailable = false;
            for (var k = 0; k < timeslots; k++) {
              if (matrixAvail[professor][k] == 1) {
                timeslotAvailable = true;
                schedule.push([professor, k]);
                score += matrixPref[j][professor];
                // make the professor unavailable at the timeslot for the copy
                matrixAvail[professor][k] = 0;
                break;
              }
            }
            if (timeslotAvailable == false) {
              score += 10000;
              schedule.push([professor, 0]);
            }
          }

        }
        // // if the score is less than 100, print the schedule
        // if (score < 100) {
        //   document.getElementById("result").innerHTML += "<br>Schedule " + (i + 1) + ": <br>";
        //   for (var j = 0; j < schedule.length; j++) {
        //     document.getElementById("result").innerHTML += studentsArray[j] + " meets with " + professorsArray[schedule[j][0]] + " at timeslot " + (schedule[j][1] + 1) + "<br>";
        //   }
        //   document.getElementById("result").innerHTML += "Score: " + score + "<br>";
        // }

        // if the score is better than the best score, replace the best score and the best schedule
        if (score < bestScore) {
          bestScore = score;
          bestSchedule = schedule;
        }
      }
      // print the best schedule and the best score
      document.getElementById("result").innerHTML += "<br>Best schedule: <br>";
      for (var i = 0; i < bestSchedule.length; i++) {
        document.getElementById("result").innerHTML += studentsArray[i] + " meets with " + professorsArray[bestSchedule[i][0]] + " at timeslot " + (bestSchedule[i][1] + 1) + "<br>";
      }
      document.getElementById("result").innerHTML += "Best score: " + bestScore + "<br>";

      // reset everything when reset button is pressed
      var reset = document.createElement("input");
      reset.type = "button";
      reset.value = "Erase"
      div.appendChild(reset);
      reset.addEventListener("click", function() {
        document.getElementById("result").innerHTML = "";
        document.getElementById("details").innerHTML = "";
        div.removeChild(reset);

        // reset all variables
        numberOfStudents = 0;
        numberOfProfessors = 0;
        timeslots = 0;
        studentsArray = [];
        professorsArray = [];
        matrixPref = [];
        matrixAvail = [];
        bestSchedule = [];
        bestScore = 99*numberOfStudents;      
      });
    });
  }